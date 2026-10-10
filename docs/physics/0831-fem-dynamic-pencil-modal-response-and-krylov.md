# FEM dynamic pencil, modal response, and Krylov solvers

- Status: FEM CPU and FEM GPU `source_visible / unvalidated`; the public
  stage-first modal and driven-response authoring, native operator boundaries,
  CPU Schur solver and GPU PETSc/SLEPc adapter are visible in source, but this
  page records no current-snapshot managed runtime or production qualification
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-09-29
- Related architecture:
  - `docs/architecture/backend-golden-masterplan.md`
- Related physics notes:
  - `0600-fem-eigenmodes-linearized-llg.md`
  - `0700-frequency-domain-linearized-llg.md`
- `0828-fem-frequency-domain-floquet-demag.md`
- `0830-fem-poisson-airbox-modal-eigen.md`
- `docs/adr/0031-fem-nonzero-k-dispersion-representations.md`
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
| $q$, $q_r$, $q_{\mathrm{src}}$, $q_{\mathrm{dst}}$ | full and reduced tangent-plane coefficient vectors | $1$ |
| $\mathbf M_T$ | positive geometric tangent-space FEM mass matrix used for modal overlap and candidate deduplication | $\mathrm{m^3}$ |
| $\eta_M$ | normalized absolute overlap in the geometric tangent-mass metric | $1$ |
| $\mathbf H_{\mathrm{eff},0}$, $\delta\mathbf h$ | static effective field and RF field phasor | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $K_u$ | first-order uniaxial anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf u$ | normalized uniaxial easy axis | $1$ |
| $H_a$ | signed uniaxial field coefficient | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ex},0},\mathbf H_{\mathrm{demag},0},\mathbf H_{K,0},\mathbf H_{\mathrm{ext},0}$ | certified static exchange, demagnetizing, uniaxial and external fields | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\gamma$, $\gamma_0$ | gyromagnetic ratio and $\mu_0|\gamma|$ in the A/m convention | $\mathrm{rad\,s^{-1}\,T^{-1}}$, $\mathrm{rad\,s^{-1}\,(A\,m^{-1})^{-1}}$ |
| $\omega$, $\omega_r$, $\Gamma$, $\omega_{\mathrm{target}}$, $\tau$ | complex angular frequency, oscillation part, decay rate, requested angular target and rotated target | $\mathrm{rad\,s^{-1}}$ |
| $f$ | cyclic frequency, $f=\operatorname{Re}(\omega)/(2\pi)$ | $\mathrm{Hz}$ |
| $\lambda$, $\sigma$ | generalized eigenvalue and complex spectral shift | $\mathrm{s^{-1}}$ |
| $\sigma_{\mathrm{R}}$, $\sigma_{\mathrm{I}}$ | real and imaginary parts of the spectral shift | $\mathrm{s^{-1}}$, $\mathrm{rad\,s^{-1}}$ |
| $L$, $K$, $A_{qq}$, $A_{qq}^{\mathrm{full}}$ | dynamic, energy-Hessian and full-space magnetic restoring operators | $\mathrm{m^3\,s^{-1}}$ |
| $B_\alpha$, $B_{qq}$, $B_{qq}^{\mathrm{full}}$, $G$ | damped gyrotropic/mass operators | $\mathrm{m^3}$ |
| $A_\omega$ | driven harmonic operator $\mathrm{i}\omega B_\alpha-L$ | $\mathrm{m^3\,s^{-1}}$ |
| $b$ | projected tangent RF drive | $\mathrm{m^3\,s^{-1}}$ |
| $\phi$, $\phi_r$, $\delta\phi$ | full and reduced scalar-potential coefficient vectors and perturbation | $\mathrm{A}$ |
| $A_{q\phi}$, $A_{q\phi}^{\mathrm{full}}$ | full/reduced potential-to-magnetic coupling blocks | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $A_{\phi q}$, $A_{\phi q}^{\mathrm{full}}$ | full/reduced magnetic-to-potential coupling blocks | $\mathrm{A\,m}$ |
| $P$, $P^{\mathrm{full}}$ | reduced and full scalar Poisson blocks | $\mathrm{m}$ |
| $c$, $\eta$ | mean-zero gauge vector and Lagrange multiplier | $\mathrm{m^3}$, $\mathrm{A\,m^{-2}}$ |
| $r_q$, $r_q^{\mathrm{full}}$, $r_\phi$, $r_\phi^{\mathrm{full}}$, $r_g$ | reduced/full magnetic, reduced/full scalar and gauge residuals | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $\epsilon_{\phi,\mathrm{probe}}$ | maximum componentwise original potential-equation backward error in the K0 probe | $1$ |
| $i$ | row index of original scalar potential equation | $1$ |
| $\epsilon_q$, $\epsilon_\phi$, $\epsilon_{q,\mathrm{proj}}$, $\epsilon_{\phi,\mathrm{proj}}$, $\epsilon_g$, $\epsilon_{\mathrm{full}}$ | normalized reduced, projected full-block and gauge residuals | $1$ |
| $V$, $W$, $y$ | trial basis, test basis and reduced coordinates | $1$ |
| $Q$ | physical vector transformation across a periodic map | $1$ |
| $R_{\mathrm{member}\leftarrow\mathrm{rep}}=T_{\mathrm{member}}^{\mathsf T}T_{\mathrm{rep}}$ | real coordinate map between local tangent bases for a pure-translation magnetic periodic class | $1$ |
| $\mathbf k$ | Bloch wave vector | $\mathrm{rad\,m^{-1}}$ |
| $\Delta\mathbf r$ | periodic lattice translation | $\mathrm{m}$ |
| $p=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r)$ | Floquet phase | $1$ |
| $\mathbf u_{n\mathbf k}$ | periodic envelope of a full Bloch mode | $1$ |
| $C(\mathbf k)$, $C_q(\mathbf k)$, $C_\phi(\mathbf k)$ | complex constraint or prolongation maps from reduced to full Bloch fields | $1$ |
| $\widetilde{\mathbf M}_{n\mathbf k}$ | dynamic magnetization phasor in A/m | $\mathrm{A\,m^{-1}}$ |
| $\widetilde\phi_{n\mathbf k}$ | full Bloch scalar-potential phasor | $\mathrm{A}$ |
| $\widetilde{\mathbf h}_{d,n\mathbf k}$ | dynamic demagnetizing-field phasor | $\mathrm{A\,m^{-1}}$ |
| $\nabla$, $\nabla_\perp$ | ordinary spatial and transverse gradients | $\mathrm{m^{-1}}$ |
| $D_{\mathbf k}$ | shifted transverse envelope gradient | $\mathrm{m^{-1}}$ |
| $D_{\mathbf k}=\nabla_\perp-\mathrm{i}k\hat{\mathbf z}$ | shifted gradient used only by the transverse waveguide envelope | $\mathrm{m^{-1}}$ |
| $\hat{\mathbf z}$ | waveguide propagation direction | $1$ |
| $k$ | signed scalar wave number along the waveguide axis | $\mathrm{rad\,m^{-1}}$ |
| $\Omega$, $\Omega_m$, $\Omega_a$ | full cell, magnetic and air subdomains | $\mathrm{m^3}$ |
| $v$ | scalar-potential test function | $1$ |
| $\mathbf R$ | lattice translation of the periodic envelope | $\mathrm{m}$ |
| $\mathrm dV$ | volume integration measure | $\mathrm{m^3}$ |
| $\delta\mathbf M_\perp$, $\delta M_z$ | transverse and longitudinal components of the dynamic magnetization in a waveguide section | $\mathrm{A\,m^{-1}}$ |
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

The default native mapper classifies a mode as zero-frequency only when its
finite, phase-adjusted angular frequency is exactly zero. An explicitly
supplied ModeKinematicsPolicy may instead apply an inclusive absolute
tolerance in rad/s. This numerical classification does not certify a
nullspace or a Goldstone mode; frequency-window and residual admission remain
separate checks.

If `omega = omega_r + i Gamma`, then `Gamma > 0` means decay because
`exp(+i omega t)=exp(+i omega_r t-Gamma t)`. Artifacts therefore record the
phasor convention, complex `lambda`, complex `omega_rad_s`, cyclic frequency,
damping rate, and linewidth mapping together.

An importer using `exp(-i omega t)` maps into this convention by complex
conjugating the phasor representation and reversing the eigenvalue/frequency
signs consistently. It is not a second implementation path.

The existing modal request's `phase_convention` selects the temporal mapping
used for the returned signed eigenvalue. For a request using
$e^{-\mathrm{i}\omega t}$,

```{math}
:label: eq-fem-eigen-frequency-mapping-exp-minus
\lambda=-\mathrm{i}\omega,
\qquad
\omega=\mathrm{i}\lambda,
\qquad
f=\frac{\operatorname{Re}(\omega)}{2\pi}.
```

The mapper keeps the input complex `lambda` unchanged. The positive physical
frequency branch is selected from the signed imaginary part: positive for
$e^{+\mathrm{i}\omega t}$ and negative for $e^{-\mathrm{i}\omega t}$. Frequency
and angular frequency retain that sign; taking $|\operatorname{Im}(\lambda)|$ would erase the requested
branch. This temporal choice is independent of the spatial Floquet phase
$p=\exp(-\mathrm{i}\mathbf{k}\cdot\Delta\mathbf{r})$ defined by
`eq-fem-dynamic-floquet-constraint`; a
change of temporal phasor convention does not conjugate or replace the spatial
Bloch phase. No Python or `ProblemIR` field changes here; the existing native
modal request carries this convention. Successful result JSON records the
actual `phasor_convention` in the top-level kinematics object and each returned
mode. This is additive result provenance, not a new Python, `ProblemIR`, or
C ABI request field.

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
- Nonzero-k demag has a source-visible CPU shared-domain Floquet/airbox
  implementation and an explicit `magnetostatic_bc="floquet_airbox"` request,
  but it remains runtime- and physics-unqualified until the full complex FE
  constraint, residual controls, managed execution, and convergence evidence
  pass. Nonzero-k DMI remains unavailable until its corresponding FE operator
  is implemented and validated.

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

(floquet-shifted-true-convergence)=
### Shifted KSP: true residual before convergence

The controlled DE trial at $k_y=15\cdot10^6\,\mathrm{rad/m}$ exposed a
recursive/true-residual gap. A positive recursive KSP reason is insufficient
for an inner solve. The production convergence decision must separately check

```{math}
:label: eq-floquet-shifted-true-convergence
\lVert b_\sigma-A_\sigma x_\sigma\rVert_2
\leq \max(\mathrm{atol},\mathrm{rtol}\lVert b_\sigma\rVert_2).
```

| Field or symbol | Meaning | SI unit / allowed representation |
|---|---|---|
| $A_\sigma$ | Actual PETSc shifted Schur operator, in the existing normalized solver coefficient equation | $1$ (normalized algebraic operator) |
| $x_\sigma$ | Current reconstructed coefficient vector of the inner shifted solve; no new physical observable | $1$ (solver coefficients) |
| $b_\sigma$ | Current normalized algebraic RHS of the inner shifted solve | $1$ (normalized solver equation) |
| $\mathrm{rtol}$ | Requested dimensionless shifted-solve relative tolerance | $1$ |
| $\mathrm{atol}$ | Requested shifted-solve absolute tolerance in the same normalized algebraic units as the RHS norm | $1$ (normalized solver equation) |

The symbols $x_\sigma$ and $b_\sigma$ denote the existing normalized
algebraic coefficient equation, not the physical RF drive $b$ defined elsewhere.
No extra normalization is introduced by the convergence callback.

Here $A_\sigma$ is the actual shifted Schur operator applied by PETSc,
$x_\sigma$ is the current reconstructed coefficient vector and $b_\sigma$ its current RHS.
The residual and absolute tolerance use the same algebraic units as $b_\sigma$;
relative tolerance is dimensionless. This inner algebraic criterion is distinct
from mode-frequency error, mesh convergence and the original descriptor gate.
A zero RHS uses the absolute criterion, including exact zero when both
thresholds are zero. No multiplier relaxes the requested tolerance.

A dedicated convergence callback preserves PETSc's negative divergence,
iteration-budget and cancellation outcomes. A provisional positive recursive
reason requires reconstruction of the current solution and explicit shifted
operator application; if the true criterion fails, convergence is withheld.
Postsolve measurements remain an independent check for every inner RHS,
including historical violations. Workspace vectors belong to one shifted KSP
and are reused; a measurement error must fail the solve rather than certify it.
The operator, Poisson realization, public Python/IR and physical $10^{-8}$
mode gate do not change. The FEM CPU callback is in implementation; managed
runtime proof and the $+15$ retry remain **NOT VERIFIED**. FEM GPU requires its
own realization and evidence; FDM CPU/GPU are outside this callback's scope.

Source owner: `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp`
and its shifted-convergence helper. Required regression: an artificially small
recursive norm with a large true residual must not return a positive reason;
zero RHS and negative/budget outcomes must retain their semantics.
PETSc documents the convergence extension point and approximate default norm:
[KSPSetConvergenceTest](https://petsc.org/release/manualpages/KSP/KSPSetConvergenceTest/),
[KSPBuildSolution](https://petsc.org/release/manualpages/KSP/KSPBuildSolution/).

Every reported mode carries an `original_operator_residual` derived from these
blockwise scaled residuals. It may not be capped by or reconstructed from the
solver-reported residual. Driven solves similarly report tracked Krylov
residuals and recomputed true unpreconditioned residuals against `A_omega`.

For the native shared-domain Floquet eigensolver, the implemented reduced-block
normalization is

```{math}
:label: eq-fem-floquet-block-residuals
\begin{aligned}
\epsilon_q&=\frac{\lVert A_{qq}q+A_{q\phi}\phi-\lambda B_{qq}q\rVert_2}
{\lVert A_{qq}q\rVert_2+\lVert A_{q\phi}\phi\rVert_2+|\lambda|\lVert B_{qq}q\rVert_2},\\
\epsilon_\phi&=\frac{\lVert P\phi+A_{\phi q}q\rVert_2}
{\lVert P\phi\rVert_2+\lVert A_{\phi q}q\rVert_2}.
\end{aligned}
```

These are dimensionless algebraic defects in Euclidean coefficient-vector
norms. The implementation adds `numeric_limits<double>::min()` to each
denominator as a numerical zero guard. Neither quantity is a relative
frequency error or a mesh-convergence estimate. The requested `solver_rtol`
limits their maximum; the DE-SMOKE value `1e-8` has not been calibrated against
a frequency-error budget. Full descriptor and seam certification remain
separate requirements.

For the sparse shared-domain nonzero-$\mathbf k$ path, the native candidate
must also pass an independent reconstruction from the retained full-field
blocks. Let $C_q(\mathbf k)$ and $C_\phi(\mathbf k)$ prolong the reduced
tangent and scalar coefficients to the unconstrained mesh. The admissible
weak residuals are evaluated by applying each full block first and then
testing with the adjoint constraint:

```{math}
:label: eq-fem-floquet-full-projected-residuals
\begin{aligned}
q&=C_q(\mathbf k)q_r,
&\phi&=C_\phi(\mathbf k)\phi_r,\\
r_q^{\mathrm{full}}
&=A_{qq}^{\mathrm{full}}q
  +A_{q\phi}^{\mathrm{full}}\phi
  -\lambda B_{qq}^{\mathrm{full}}q,
&\epsilon_{q,\mathrm{proj}}
&=\frac{\lVert C_q^\mathsf{H}r_q^{\mathrm{full}}\rVert_2}
{\lVert C_q^\mathsf{H}A_{qq}^{\mathrm{full}}q\rVert_2
 +\lVert C_q^\mathsf{H}A_{q\phi}^{\mathrm{full}}\phi\rVert_2
 +|\lambda|\lVert C_q^\mathsf{H}B_{qq}^{\mathrm{full}}q\rVert_2},\\
r_\phi^{\mathrm{full}}
&=A_{\phi q}^{\mathrm{full}}q+P^{\mathrm{full}}\phi,
&\epsilon_{\phi,\mathrm{proj}}
&=\frac{\lVert C_\phi^\mathsf{H}r_\phi^{\mathrm{full}}\rVert_2}
{\lVert C_\phi^\mathsf{H}A_{\phi q}^{\mathrm{full}}q\rVert_2
 +\lVert C_\phi^\mathsf{H}P^{\mathrm{full}}\phi\rVert_2}.
\end{aligned}
```

Projection onto the admissible test spaces is intentional: the unprojected
full-row residual may contain reactions associated with the periodic
constraints. The certificate separately checks the scalar phase seam, the
local tangent-frame transport, the reconstructed Cartesian magnetic seam,
and equilibrium magnetization continuity on periodic node pairs. At least
one active magnetic pair must be present. Each normalized weak residual and
seam residual must be finite and no larger than the requested algebraic
tolerance; the artifact keeps reduced-block and reconstructed full-field
values in separate fields.

At nonzero $\mathbf k$, the scalar block must use the boundary-matched policy:
`pure_neumann` requires `require_invertible`, whereas `poisson_robin` and
`poisson_dirichlet` require `none`. No mean-zero gauge residual is reported for
this path; the gauge field is `null` and its applicability is represented by
the policy evidence. The full-descriptor certificate does not certify the
external geometric boundary or its flux condition, so
`floquet_geometric_bc_certified` remains false.

SLEPc's
`EPSSetTrueResidual` with `EPS_CONV_ABS` controls convergence using the
absolute 2-norm of the true pencil residual. `EPSComputeError(...,
EPS_ERROR_ABSOLUTE)` reports the same kind of absolute quantity; it is not the
per-mode normalized magnetic residual above. The pencil's global normalization
does not remove this distinction because the physical residual denominator is
formed from the current mode's magnetic and demagnetizing block actions. The
EPS tolerance is currently a candidate-search prefilter, set to
$\max(100\epsilon_{\rm machine},10^{-3}\,\mathrm{rtol}_{\rm requested})$.
The multiplier is an uncalibrated heuristic, not a derived bound between the
two residual definitions. It can exclude useful diagnostic candidates without
improving their original residual. Final acceptance still requires each
reconstructed original-block residual to meet the requested algebraic
tolerance. See the SLEPc documentation for
[`EPSSetConvergenceTest`](https://slepc.upv.es/release/manualpages/EPS/EPSSetConvergenceTest.html),
[`EPSSetTrueResidual`](https://slepc.upv.es/release/manualpages/EPS/EPSSetTrueResidual.html),
and [`EPS_ERROR_ABSOLUTE`](https://slepc.upv.es/release/manualpages/EPS/EPSErrorType.html).

The inner Poisson `KSPPREONLY`/LU applies a factorization once: its recorded
iterative tolerances do not control its accuracy. The shift-invert GMRES
diagnostic from `KSPGetResidualNorm` may be approximate or preconditioned and
is not an independently recomputed relative residual of the original linear
system. The current path does not explicitly select or record the PC side and
norm type. A positive KSP convergence reason does not resolve that missing
measurement. See [`KSPPREONLY`](https://petsc.org/release/manualpages/KSP/KSPPREONLY/)
and [`KSPGetResidualNorm`](https://petsc.org/release/manualpages/KSP/KSPGetResidualNorm/).

The production shared-domain K0 Schur adapter uses an explicit bounded
Krylov policy when integrating the K0 selected-spectrum implementation. For
real-split dimension $N\ge2$, first cap $n_{ev}$ at $N-1$ and choose
$n_{cv}=\min(N,\max(n_{ev}+1,2n_{ev}))$, using an overflow-safe bound for
$2n_{ev}$. This controls memory and avoids requesting the complete projected
spectrum; it does not certify convergence. See
[EPSSetDimensions](https://slepc.upv.es/release/manualpages/EPS/EPSSetDimensions.html).
A standalone positive nearest-frequency request uses two real Ritz vectors
per requested physical mode, corresponding to its $J$-equivalence class.
Frequency-window subcalls retain four-vector oversampling, even though their
internal target enum is `nearest_frequency`: the borrowed window operator
context identifies these calls. Zero/nonpositive targets also retain four.
The window scheduler, refinement, coverage certificate, cancellation,
cached preconditioner and original descriptor residual limits remain binding.
A nonpositive EPS convergence reason never publishes an accepted mode.
The partial-EPS integration preserves counters before a nonpositive EPS
reason is handled. If no Ritz vector converged, it returns the original error
immediately. If some converged, their original Schur/full-descriptor residuals
may be reconstructed for diagnostics only; the nonpositive EPS reason still
returns `solve_error` before mode selection or publication. Cancellation is
separate and retains the existing interrupted-result contract. At most four
positive reconstructed samples expose full, magnetic, Poisson and gauge
backward errors. Diagnostic formatting is bounded: sample exhaustion sets
`reconstructed_samples_available=false`; overall JSON exhaustion sets
`available=false` with `diagnostic_buffer_exhausted`. Cancellation is polled
again after reconstruction and takes precedence over the EPS failure reason.
The KSP label is `gmres`, including exact shifted preconditioning.
This integration is source-level until a new source-bound runtime-only build and scientific
receipts verify both standalone K0 and full window behavior. The separate
Floquet adapter retains its own Krylov policy below.

For the small-mode shared-domain Floquet path, the solver currently requests
`ncv = min(N, max(32, 2 nev))`, where `N` is the real-split operator dimension
and `nev` is the number of requested Ritz values. This was a bounded convergence
experiment for the observed interior-spectrum stagnation; it does not change
the eigenproblem or acceptance criteria. The run records the resolved
`nev`, `ncv`, and `mpd` returned by SLEPc. Larger `ncv` may increase memory and
does not establish convergence by itself. Managed job #136 resolved `nev=8`,
`ncv=32`, `mpd=32` but still reached 2000 iterations per window without a
converged pair. The logged 100 tangent DOFs are complex coefficients; the
real-split pencil has dimension 200. No FP64 accuracy floor or optimal residual
threshold has been established. The next calibration compares the original
small Schur pencil with a direct reference and measures the true inner-solve
residual, before independently sweeping candidate and acceptance tolerances.
Details and source-pinned evidence are in the
[threshold audit](../audits/2026-09-25-de-residual-threshold-audit.md).

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

The static longitudinal-field contribution uses the same nodal Cartesian
trial field as exchange and the gyrotropic block. With dimensionless nodal
tangents and shape functions, its element entries are

```{math}
:label: eq-fem-modal-static-field-frame-transport
A^{H}_{(i,a),(j,b)} = \int_{\Omega_m} \mu_0 M_s
(\mathbf m_0\cdot\mathbf H_{\mathrm{eff},0}) N_i N_j
(\mathbf e_{a,i}\cdot\mathbf e_{b,j})\,\mathrm dV.
```

The field is in A/m, magnetisation in A/m, and this energy Hessian is in J.
The physical field remains parallel to the accepted equilibrium within the
existing tolerance. A local identity for every node pair is valid only for a
common tangent basis; arbitrary nodal coordinate rotations require both nodal
projections. This correction changes no Python, ProblemIR, planner legality,
artifact schema or GPU/FDM implementation. Dynamic demagnetisation remains
owned by the coupled potential, not this local term. Native CPU covariance,
common-frame parity and managed runtime validation are required; source
regression coverage alone does not certify execution. It does not explain
uniform-film DE/BV discrepancies when all tangent frames coincide.

The next native CPU interaction increment is first-order uniaxial bulk
anisotropy, with the energy convention of `0402-uniaxial-anisotropy.md`.
For a constant unit axis and constant field coefficient,

```{math}
:label: eq-fem-modal-uniaxial-energy-hessian
w_K=-K_u(\mathbf m\cdot\mathbf u)^2,\qquad
H_a=\frac{2K_u}{\mu_0 M_s},\qquad
A^{K,\mathrm{derivative}}_{(i,a),(j,b)}
=-\int_{\Omega_m}\mu_0 M_s H_a N_iN_j
(\mathbf e_{a,i}\cdot\mathbf u)(\mathbf u\cdot\mathbf e_{b,j})\,\mathrm dV.
```

This negative field-derivative contribution is added to the longitudinal
curvature above, which uses the **total** accepted effective field, including
anisotropy. The curvature must also be assembled for an anisotropy-only
request without a Zeeman term. Positive and negative finite coefficients are
both permitted; stability is determined by the total constrained Hessian.
A zero accepted effective field is a stationary state, not a certificate of
zero energy curvature. The shared-domain scope gate accepts finite nonnegative
field and torque amplitudes, including zero; the Hessian and spectral gates
still decide whether a usable mode exists. For example, an easy-plane Ku
with its axis perpendicular to m0 has H_K(m0)=0 and a nonzero transverse
second derivative. At nonzero k, exchange adds curvature in both tangent
directions. This does not remove the public Ku guard or certify the native
execution of that model.

The existing C ABI stores the axis at every scalar node (`3*node_count`) and
one field coefficient in A/m. The first increment normalizes finite nonzero
nodal axes and requires their rank-one axes to agree within `1e-12`; a
nonconstant axis or field view remains unsupported. No spatial axis,
second-order Ku, cubic anisotropy, surface term or DMI is inferred from this
increment. Native assembly coverage does not change public planner legality
until the Rust transport, identities, equilibrium fields and managed gates
are connected. GPU and FDM receive no new implementation from this change.
The equilibrium material identity keeps the exact v1 preimage for requests
without Ku. A request with finite signed constant Ku uses a v2 namespace and
binds Ku in J/m3 and the canonical unit axis: the first nonzero axis component
is positive, signed zero is removed, and the default axis is z. Both relaxation
producer and modal consumer use the same builder. A scaled or opposite axis
represents the same rank-one energy, while a changed Ku or physical axis must
invalidate the stored equilibrium. Uniform Ms is required for this increment;
spatial coefficients, second-order and cubic terms remain unsupported.
The bounded Ku artifact pair uses `equilibrium_artifact.v8` and
`LinearizationState.v7`. Its `material_signature` and native
`material_snapshot_id` use the canonical equilibrium material identity.
The separate `material_provenance_signature` hashes the raw MaterialIR of
the current materialization plan, with
`material_provenance_scope=materialization_plan` and
`material_identity_kind=canonical_equilibrium_material.v2`.
This scope does not reconstruct the original authored relaxation material.
A provided v8 source artifact is checked against the accepted physical
identity. The persisted v8 artifact and v7 state both carry the current
materialization plan's raw hash; linearization_identity.v2 separately retains
the exact producer and consumer raw preimages and signatures. Equivalent scaled/opposite axes may
have different raw hashes, but must share the canonical signature. Legacy
v7/v6 keeps its raw semantics and digest preimages; it cannot become a Ku
source by relabeling. Filenames and manifest keys match the actual schemas.
Public Ku remains gated pending managed runtime and scientific validation.

R4 identity replay first preserves the exact serialized preimages alongside
all equilibrium and modal identity digests. The digest remains namespace,
zero separator, little-endian byte length and the same compact JSON bytes.
Ku-free material keeps v1 bytes; constant Ku keeps canonical v2 bytes, including
the sign/scaling equivalence of its axis. These strings are internal replay
inputs, not a substitute for accepted/recomputed field certificates or a new
published artifact schema. End-to-end replay and managed qualification remain
pending; adding preimages alone does not certify equilibrium provenance.

Kontrakt agregacji multi-k R4: podpisane sidecars accepted fields V1/V2 i
linearization identity V2 otrzymują ścieżkę `eigen/metadata/sample_NNNN/`.
Relokacja musi zachować dokładne bajty payloadu, w tym preimages i tożsamość
źródłowej siatki; nie wolno przepisywać napisów `sample_0000` wewnątrz
podpisanego dokumentu. To samo dotyczy istniejących equilibrium/state sidecars.
Manifest wiąże próbkę przez ścieżkę, a nie przez mutację dokumentu.
Evidence wszystkich policzonych próbek pozostaje także dla spectrum-only oraz
przy selekcji mode fields tylko z części próbek. Selekcja pól nie usuwa dowodu
stanu równowagi ani tożsamości operatora.
Publikowane tablice ścieżek muszą odpowiadać rzeczywiście obecnym sidecars,
bez syntetycznych plików dla nieobliczonych próbek. Runtime i pełny accepted
replay pozostają osobnymi, jeszcze niezweryfikowanymi bramkami.


The equilibrium observer registers Ku as a typed anisotropy interaction, never
as a frozen per-node external field. This keeps Zeeman and anisotropy energies
and field components separate and evaluates Ku at the actual accepted m0.
This source increment does not remove public planner guards or certify runtime.

Required evidence includes easy-axis curvature, transverse-axis derivative,
signed coefficient, nodal-basis covariance, invalid/unsupported view rejection,
then full payload binding, K0 and reciprocal nonzero-k runtime checks.

The static field certificate for the Ku increment uses a separate explicit
anisotropy channel. Legacy `CertifiedFemEquilibriumFields.v1` keeps four vector
views (exchange, demag, external and effective) and its exact digest bytes.
`CertifiedFemEquilibriumFields.v2` adds `h_anisotropy_a_per_m`, representing
first-order uniaxial bulk anisotropy in this increment, and a distinct namespace.
For the certified CPU realization the decomposition is

```{math}
:label: eq-fem-certified-static-fields-ku
\mathbf H_{\mathrm{eff},0}
=\mathbf H_{\mathrm{ex},0}+\mathbf H_{\mathrm{demag},0}
+\mathbf H_{K,0}+\mathbf H_{\mathrm{ext},0}.
```

The verifier uses the CPU producer's addition order
`((H_ex + H_demag) + H_K) + H_ext`, without replacing the measured H_eff.
The views contain one finite vector per node, with the native dynamical mask
rather than a visual airbox field. The v2 binary digest binds exchange, demag,
anisotropy, external, effective and potential in that order, with u64 little-
endian counts and IEEE754 f64 little-endian values. V1 keeps its existing
exchange/demag/external/effective/potential order. A v1 record carrying Ku
views, a v2 record missing Ku views, unknown versions, invalid cardinalities,
non-finite values or a failed decomposition are rejected. The material's
advertised Ku term must agree with the field certificate version, even for
an explicitly authored zero Ku. Ku cannot be hidden inside H_ext.

The native final-state refresh certificate likewise writes v2 for Ku,
including its anisotropy comparison and both field digests. V1 without Ku
keeps its serialization and namespace. Published artifact filenames follow
the actual version. This extends a certificate, not solver readiness; public
Ku legality and all managed CPU/GPU scientific gates remain separate.

All producer and consumer artifact paths use the same material-version selector,
including stage orchestration and each independently relaxed bias-sweep sample.
There is no v2-to-v1 fallback. A missing optional legacy view is distinct from
an explicitly present null, which both readers reject. Before field capture
and certificate publication the source scope rejects unrepresented drives,
current/Oersted, stochastic/thermal, mechanical, spatial Ku/axis or sharp element material, higher-order and DMI
contributions. The bounded Ku realization requires uniform positive Ms; legacy nodal A remains
digest-bound in material identity. GPU linearization field export also requires
a valid accepted-endpoint observable cache, but GPU physics remains unqualified.
Historical refresh certificates with only a recomputed payload carry an
accepted-fields digest as trusted producer evidence; they do not prove
independent accepted-field replay. The R4 source increment publishes a separate
immutable accepted endpoint payload and the consumer independently hashes both
payloads, replays all recorded field/phi differences, and enforces the shared
tolerances. V2 also replays anisotropy, including explicit Ku=0. The verified
constructor is used by the runner and CLI; the legacy constructor is internal.
Full V3/source identity binding, Python artifact replay and managed runtime
remain separate open gates. Historical artifacts are not relabelled as R4 proof.

Constraint construction operates on complete corner/edge equivalence classes
and checks cycle consistency. A phase-only tangent constraint is invalid for
varying frames.

The shared-domain CPU modal implementation currently supports pure translations
(`Q=I`). It permits different local `e1/e2` coordinate bases when the physical
equilibrium magnetization agrees across every member of a magnetic periodic
class. With representative and member tangent maps `T_rep` and `T_member`, it
forms the real coordinate rotation

```{math}
:label: eq-fem-modal-tangent-frame-rotation
R_{\mathrm{member}\leftarrow\mathrm{rep}}
=T_{\mathrm{member}}^{\mathsf T}T_{\mathrm{rep}},
\qquad
q_{\mathrm{member}}
=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r)
R_{\mathrm{member}\leftarrow\mathrm{rep}}q_{\mathrm{rep}}.
```

This `R` changes tangent coordinates only; it is not a physical spin-space
rotation `Q`. The modal importer requires finite, orthonormal, right-handed
frames and matching equilibrium magnetization vectors within its declared
frame tolerance (`0 < tolerance < 1`). A class with a physically different equilibrium or a
nonidentity spin-space `Q` is rejected because the current modal periodic-pair
payload carries no such `Q`. The separate driven-response Floquet validator
still requires matching local frames; do not infer this modal coordinate-map
support for that route.

(nonzero-k-representations)=
### 3.5 Two nonzero-$k$ representations

The modal product has two physically different realizations. The first is a
three-dimensional periodic cell. The second is a two-dimensional transverse
cross-section of a waveguide that is invariant along one axis. They share the
phase convention, tangent LLG pencil, artifacts and provenance vocabulary, but
they do not share the same differential operator.

(full-bloch-operator-contract)=
#### 3.5.1 Full Bloch field in a periodic 3D cell

For a full 3D cell, the physical phasor is written with the canonical Fullmag
sign as a periodic envelope times a Bloch phase:

```{math}
:label: eq-fem-full-bloch-ansatz
\widetilde{\mathbf m}_{n\mathbf k}(\mathbf r)=\mathbf u_{n\mathbf k}(\mathbf r)
\exp(-\mathrm{i}\mathbf k\cdot\mathbf r),
\qquad
\mathbf u_{n\mathbf k}(\mathbf r+\mathbf R)=\mathbf u_{n\mathbf k}(\mathbf r),
\qquad
\mathbf m_0(\mathbf r)\cdot\mathbf u_{n\mathbf k}(\mathbf r)=0.
```

The finite-element fields are the full complex phasors. Their element
derivatives are ordinary spatial derivatives. The Bloch phase is imposed by
the complex seam constraint $C(\mathbf k)$ on magnetic tangent coefficients and
on the scalar-potential field. The constraint may be represented by a
prolongation, a reduced basis or an equivalent matrix-free
$C(\mathbf k)^\mathsf{H} A C(\mathbf k)$ action. It must transport the physical
tangent frame, so for the interleaved local layout the per-node relation
remains $q_{\mathrm{dst}}=p(T_{\mathrm{dst}}^\mathsf{T}Q T_{\mathrm{src}})q_{\mathrm{src}}$.

The newly added native foundation names its map operations
`FloquetTangentProlongation::initialize`, `prolong` and `restrict_adjoint`, and
its MFEM wrapper operations `FloquetReducedMagneticOperator::Mult` and
`MultTranspose`. These names identify a source boundary only: the code is
uncompiled, unvalidated and not connected to the production solver ABI.

Do not replace this formulation with a shifted derivative. Applying both
ordinary derivatives on a phase-constrained full field and
$\nabla-\mathrm{i}\mathbf k$ to the same field counts the wave vector twice.
The scalar-potential block is part of the same phase-constrained airbox when
dynamic demagnetization is enabled:

```{math}
:label: eq-fem-full-bloch-demag
\widetilde{\mathbf M}_{n\mathbf k}=M_s\widetilde{\mathbf m}_{n\mathbf k},
\qquad
\nabla^2\widetilde\phi_{n\mathbf k}=\nabla\cdot\widetilde{\mathbf M}_{n\mathbf k}
\ \text{in }\Omega_m,
\qquad
\nabla^2\widetilde\phi_{n\mathbf k}=0\ \text{in }\Omega_a,
\qquad
\widetilde{\mathbf h}_{d,n\mathbf k}=-\nabla\widetilde\phi_{n\mathbf k}.
```

The corresponding weak form uses the same ordinary gradient and complex
sesquilinear pairing:

```{math}
:label: eq-fem-full-bloch-weak
\int_{\Omega}\nabla v^\ast\cdot\nabla\widetilde\phi_{n\mathbf k}\,\mathrm dV
=\int_{\Omega_m}\nabla v^\ast\cdot\widetilde{\mathbf M}_{n\mathbf k}\,\mathrm dV.
```

The airbox seam phase, magnetic seam phase and opposite-normal flux condition
must be checked as one corner/edge cycle. A scalar gauge is added only when
the assembled scalar operator has an actual constant nullspace; a nonzero
Bloch phase usually removes that nullspace, while an open or Robin exterior
may already be coercive. For a pure-Neumann Floquet block, invertibility must
be decided from the actual phase-constrained Poisson operator and its
factorization. A universal $|\mathbf k|L$ cutoff is not valid because phase
equivalence depends on the periodic lattice vectors, while conditioning also
depends on the assembled mesh and operator. The $\mathbf k=0$ path retains its
mean-zero augmented gauge; the nonzero-$\mathbf k$ path must not inherit that
gauge vector. Singular or numerically unusable blocks fail at factorization
or residual certification.

Residual scope is solver-path specific. The dense contour path reconstructs
the potential and evaluates the coupled descriptor. The sparse SLEPc source
now retains the unconstrained weak-form blocks and checks the projected
full-field equations and reconstructed Floquet seams described by
{eq}`eq-fem-floquet-full-projected-residuals`. This is a source-level contract,
not runtime qualification: the latest managed build predates this check, so
no nonzero-$\mathbf k$ result is certified by it yet. Even after runtime
verification, geometric outer-boundary and flux certification remains a
separate gate.

(floquet-airbox-source-convention)=
#### Konwencja źródła przy bounded dense bridge

MFEM producer przekazuje fizyczną prawą stronę słabą $S$, dla której
$P\phi=S q$. Pełny residual celowo zachowuje ten blok i sprawdza
$P\phi-Sq$; nie wolno negować go w miejscu. Sparse owner tworzy odrębny
blok descriptora $A_{\phi q}=-C_\phi^H S C_q$.
Bounded dense bridge musi użyć identycznego znaku, zanim utworzy
$A_{q\phi}=-\mu_0A_{\phi q}^H$ i zrekonstruuje
$\phi=-P^{-1}A_{\phi q}q$. Sam Schur nie wykrywa globalnej zmiany
znaku źródła, ponieważ obie jego strony zmieniają znak jednocześnie.

Wewnętrzny enum `FloquetAirboxTangentSourceConvention` rozróżnia
`descriptor_block` (default dotychczasowych algebraicznych fixtures) i
`weak_poisson_rhs` (jawnie wybierane przez shared-domain owner).
Pierwszy wariant nie zmienia znaku; drugi neguje zredukowane źródło raz,
przed sprzężeniem zwrotnym i rekonstrukcją. Nieznany wariant jest odrzucany.
Nie jest to publiczny parametr Python, ProblemIR ani zmiana artefaktu.
FDM i GPU nie otrzymują nowej trasy. Produkcyjny sparse pilot nie korzysta
z materializacji dense; #196 zachowuje niezmienne źródła.

Regresja wymaga zgodności fizycznego potencjału, reduced residualu i Schura
dla obu konwencji, zespolonego źródła i obu ograniczeń Floqueta. Raw MFEM
blok $S$ musi pozostać niezmieniony. Fixture natywny jest przygotowany,
ale niekompilowany; kontrola interpretowana sprawdza algebrę i podłączenie
źródłowe. Managed wykonanie pozostaje NOT VERIFIED.

(waveguide-envelope-operator-contract)=
#### 3.5.2 Transverse waveguide envelope

The 2.5D representation applies only when geometry, materials, equilibrium and
boundary data are translationally invariant along the selected propagation
axis $\hat{\mathbf z}$. The unknown is a transverse envelope on a 2D section;
there are no longitudinal seam pairs and no $C(\mathbf k)$ constraint. Define
the shifted derivative only for this representation:

```{math}
:label: eq-fem-waveguide-envelope-demag
D_{\mathbf k}=\nabla_\perp-\mathrm{i}k\hat{\mathbf z},
\qquad
\left(\nabla_\perp^2-k^2\right)\phi
=\nabla_\perp\cdot\delta\mathbf M_\perp-\mathrm{i}k\delta M_z,
\qquad
\mathbf h_{d,\perp}=-\nabla_\perp\phi,
\qquad
h_{d,z}=\mathrm{i}k\phi.
```

Here $k$ is the signed scalar component along $\hat{\mathbf z}$. Weak-form
integrals and energies are reported per unit waveguide length; potential
and field amplitudes retain their physical SI units. The $k\to0$ limit
must be compared against a separately assembled 2D magnetostatic operator;
it is not evidence that a 3D full-cell seam constraint can be removed. The
waveguide path is the planned S09 realization and remains unvalidated.

(waveguide-weak-source-sign)=
Znak źródła słabego musi wynikać z całkowania przez części, a nie
bezpośrednio ze znaku źródła w równaniu silnym. Dla konwencji
$\exp(-\mathrm{i}kz)$ i fizycznego potencjału $\mathbf h_d=-D_{\mathbf k}\phi$:

```{math}
:label: eq-fem-waveguide-weak-source-sign
\int_\Sigma \nabla_\perp\overline v\cdot\nabla_\perp\phi\,\mathrm dA
+k^2\int_\Sigma\overline v\phi\,\mathrm dA
=\int_\Sigma\nabla_\perp\overline v\cdot\delta\mathbf M_\perp\,\mathrm dA
+\mathrm{i}k\int_\Sigma\overline v\delta M_z\,\mathrm dA.
```

$v$ jest bezrozmiarową zespoloną funkcją testową; kreska oznacza sprzężenie.
Pozostałe symbole i jednostki podano wyżej oraz w tabeli miary przekroju.
Równanie obejmuje magnetyzację przedłużoną zerem do powietrza i jednorodny
Dirichlet na zewnętrznym brzegu; Robin dodaje swój dodatni blok brzegowy
do lewej strony. Odpowiednie źródło ma jednostkę $\mathrm A$.
Assembler zwraca blok descriptora, nie dodatnią prawą stronę:
$P\phi+A_{\phi q}q=0$. Dlatego zarówno jego człon poprzeczny, jak i osiowy
są ujemną kopią źródła słabego. Provider oblicza Schur
$-A_{q\phi}P^{-1}A_{\phi q}$. Globalny minus obu bloków źródła nie zmienia
Schura, lecz musi być spójny przy rekonstrukcji fizycznego potencjału.
Hermitowskie sprzężenie bloku zwrotnego nadal
wymaga odwrócenia znaku części urojonej.

Regresja H6 porównuje mieszane zespolone źródło P1 z niezależną kwadraturą
$\nabla\overline{(N_i\exp(-\mathrm{i}kz))}\cdot\delta\mathbf M$
w domenie ekstrudowanej, podzieloną przez jej długość. Sprawdza dodatnie,
zerowe i ujemne $k$. Błędny znak względny może przejść kontrolę samego
sprzężenia przy odwróceniu $k$, dlatego ta kontrola nie wystarcza.
Zmiana dotyczy wyłącznie bounded prototypu FEM CPU 2.5D; nie zmienia
operatora 3D ani kapsuły #196. Python, ProblemIR, FDM i GPU nie otrzymują
nowej trasy. Regresja interpretowana sprawdza wyprowadzenie i podłączenie
źródłowe; wykonanie natywne oraz routing S09 pozostają NOT VERIFIED.

(waveguide-section-measure)=
Całka po przekroju 2D jest już całką na jednostkę długości osiowej.
Dla osiowo niezmiennych funkcji P1 i ekstrudowanej domeny
$\Omega_\ell=\Sigma\times[0,\ell]$ obowiązuje:

```{math}
:label: eq-fem-waveguide-section-measure
M^\perp_{ij}=\int_\Sigma N_iN_j\,\mathrm dA
=\frac{1}{\ell}\int_{\Omega_\ell}N_iN_j\,\mathrm dV,
\qquad
K^\perp_{ij}=\int_\Sigma\nabla_\perp N_i\cdot\nabla_\perp N_j\,\mathrm dA
=\frac{1}{\ell}\int_{\Omega_\ell}\nabla_\perp N_i\cdot\nabla_\perp N_j\,\mathrm dV.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\Sigma$ | Przekrój poprzeczny | $\mathrm{m^2}$ |
| $\ell$ | Długość ekstrudowanego odcinka porównawczego | $\mathrm m$ |
| $\Omega_\ell$ | Domena ekstrudowana | $\mathrm{m^3}$ |
| $N_i,N_j$ | Bezrozmiarowe funkcje bazowe P1 | $1$ |
| $i,j$ | Indeksy funkcji testowej i próbnej | $1$ |
| $\mathrm dA$ | Miara całki po przekroju | $\mathrm{m^2}$ |
| $M^\perp_{ij}$ | Skalarna macierz masy przekroju | $\mathrm{m^2}$ |
| $K^\perp_{ij}$ | Skalarna macierz sztywności przekroju | $1$ |

Assembler `assemble_floquet_waveguide_cross_section_blocks` otrzymuje
wyłącznie współrzędne 2D i trójkąty. Nie otrzymuje całek objętościowych
z ekstrudowanego odcinka, więc nie może dzielić swoich bloków ponownie
przez długość. Pole `normalization_length_m` pozostaje dodatnią, skończoną
metadaną odcinka porównawczego (default 1 m); jest walidowane i raportowane,
ale nie skaluje bloków, pola przekroju ani długości brzegu. Dzielenie przez
$\ell$ należy do odbiornika rzeczywistych całek 3D przy porównaniu 3D/2.5D.
Nie ma publicznego parametru Python ani mapowania ProblemIR dla tego
wewnętrznego prototypu. Korekta dotyczy bounded FEM CPU; nie dodaje trasy
produkcyjnej MFEM, GPU ani FDM. Regresja natywna sprawdza niezmienność
wszystkich sześciu bloków i geometrii przy różnych długościach; jej wykonanie
pozostaje NOT VERIFIED zgodnie z zakazem kompilacji testów jednostkowych.
Interpreted check weryfikuje tożsamość miar i podłączenie źródłowe, nie runtime.

Never apply $D_{\mathbf k}$ to the full 3D phase-constrained fields. Conversely,
do not invent longitudinal seam constraints for a translationally invariant
cross-section. This separation follows the arbitrary-cross-section
propagating-mode construction in TetraX while retaining Fullmag's own FEM and
airbox contracts.

#### 3.5.3 Modal consequences shared by both representations

At each requested $\mathbf k$, the operator and constrained space are rebuilt
or applied with that $\mathbf k$; a K0 operator is not silently reused. The
selected mode carries a complex field, a declared normalization and the
requested/resolved wave-vector sample. Branch tracking uses a mass-weighted
complex overlap and the Hungarian assignment for isolated modes. At a crossing,
principal angles of mass-weighted subspaces replace scalar overlap. A damped
nonnormal pencil additionally requires left/right information for projection;
Gilbert damping and its sign are reported through $\Gamma$ under the
$\exp(+\mathrm{i}\omega t)$ convention. Every accepted mode recomputes the
original full descriptor residual, including the potential and gauge blocks.

The local Micromagnetics Module User's Guide describes the same workflow
distinction: its `Frequency Domain` interface is a driven phasor solve and its
`Eigenfrequency` interface returns natural modes. Its Floquet boundary example
uses $\exp(-\mathrm{i}\mathbf k_F\cdot(\mathbf r_{dst}-\mathbf r_{src}))$ and
the guide permits 1D, 2D and 3D periodic pairs (V.E.2--3, PDF 27--28,
printed 22--23 of the repository copy). The dynamic demagnetization example
feeds `Ms*dmX/Y/Z` into a second magnetic-fields interface and returns its
field to the linearized LLG (VII.A.2, PDF 40--43, printed 35--38). These are
workflow references, not proof of a native Fullmag or standard COMSOL LLG
implementation. The guide's DMI boundary warning (PDF 25, printed 20) is
retained as a reason to require Fullmag's own interface-variation tests.

### 3.6 FEM CPU ownership

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

#### Generic production SLEPc modal candidate pool

Generic production CPU modal requests use the geometric tangent mass already
carried by `ModalEigenRequest::mfem_mass_matrix_row_major` or
`ModalEigenRequest::mfem_sparse_mass_csr`. This matrix is distinct from the
gyrotropic generalized-pencil block $B_{qq}$: $B_{qq}$ participates in the
dynamics and is not a positive candidate-overlap metric. For two tangent
coefficient vectors, the dimensionless overlap is

```{math}
:label: eq-generic-modal-mass-overlap
\eta_M(q_a,q_b)=
\frac{|q_a^{\mathsf H}\mathbf M_T q_b|}
{\sqrt{(q_a^{\mathsf H}\mathbf M_T q_a)
\,(q_b^{\mathsf H}\mathbf M_T q_b)}}.
```

Dense and CSR payloads must apply this same geometric metric. The CSR
production path applies CSR directly; converting a sparse mass to dense, using
$B_{qq}$, or substituting identity when production mass is absent or invalid
is not an acceptable fallback. The separate `tiny_validation_*` fields remain
an explicit bounded reference request and do not make a missing production
mass valid.

Within each SLEPc attempt, only positive-frequency modes that pass the
configured original-pencil residual gate enter the raw candidate pool. Strict
mass-action deduplication operates on normalized comparison copies while
retaining each original eigenvector scale, residual, eigenpair index and
provenance. For a nearest-frequency request, candidates are ranked by distance
to the requested target before the public count cap; a frequency window
preserves its existing low-to-high presentation order after cross-subwindow
deduplication and capping. Realification/conjugate copies cannot consume the
public cap before the geometric mass test.

If the current certified EPS pool contains fewer unique modes than the
subwindow asks for, the generic adapter may monotonically increase NEV only up
to the ceiling fixed by the initially admitted NCV and real-split dimension.
The actual initial NCV and MPD stay fixed, and all attempts share the original
outer-iteration budget; a retry cannot repeat a hard shifted-KSP, descriptor,
or mass-action failure. Dimension or iteration exhaustion retains only the
last safely solved and residual-certified pool and reports an explicit partial
result. An absent or invalid geometric mass is a hard failure, not an empty
window or a successful identity-metric result.

Before overlap-based deduplication, the generic finalizer also checks the
Hermitian Gram matrix of the residual-certified candidate vectors in this
declared mass. It applies the dense or CSR mass directly to those vectors and
forms only a candidate-count-sized Gram matrix; the geometric CSR operator is
never densified. The normalized Gram must satisfy finite, Hermitian,
Cauchy-consistent, positive-semidefinite checks using a pivoted semidefinite
factorization. Its roundoff tolerance scales with machine precision and the
vector and candidate dimensions, not with an SI-unit floor. Exact phase copies
and other rank-deficient candidate spans remain admissible. This establishes
metric positivity only on the checked candidate span; it does not prove that
an arbitrary supplied mass is globally positive definite outside that span.

The generic SLEPc attempt owns its EPS, work vectors, rotated matrices and
input-matrix handles for the duration of a call. A hard `EPSSolve`, status-query,
or matrix-operation error stops further calls on that graph and quarantines its
remaining handles until process exit. Any borrowed array or matrix-row view
acquired before the error remains attached to that quarantined graph; cleanup
does not issue a follow-up PETSc call to restore or destroy it. If ordinary
object destruction fails, cleanup also stops, quarantines the remaining
handles, and makes the attempt terminal: it cannot be retried or published as
a canonical solve.
This path creates no application-owned MatShell callbacks. The quarantine is
per-call protection only; safety of `SlepcFinalize` and of cross-entrypoint
finalization remains **NOT VERIFIED** pending a process-wide runtime owner.

This is a numerical-method contract update with no new Python, ProblemIR or
public C ABI field. The source now validates the supplied dense or CSR
geometric mass, certifies the residual-approved candidate span, applies it
directly in the strict finalizer, and maps selected comparison copies back to
original SLEPc candidates. Generic windows merge
residual-certified candidates across subwindows before applying the public
output cap; sparse mass remains CSR throughout. The generic nearest/window
adapter performs bounded NEV refill with the first resolved NCV/MPD and one
cumulative outer-iteration budget. A nearest request that cannot certify its
requested count fails without publishing partial candidates as canonical
modes. A nonempty best-effort window may return a dimension-limited certified
pool with `complete=false`; budget exhaustion, strict underfill, missing or
invalid mass, an empty pool, and solver errors fail closed. The change has no
new Python, ProblemIR, or public C ABI field. The focused source regressions
exist but have not been run locally; provider-backed GHA, managed runtime, and
scientific qualification remain **NOT VERIFIED**.

For the nonzero-$k$ shared-domain Floquet route, the scalar potential is
eliminated with the original equation
$P(\mathbf k)\phi=-A_{\phi q}(\mathbf k)q$. The inner PETSc solve is
`KSPPREONLY` with `PCLU`, so it applies the LU
factorization once; its factorization policy is `MAT_SHIFT_NONE`. A shifted LU
factorization here would change the effective $P(\mathbf k)^{-1}$ inside the
Schur action, even though the assembled matrix itself remains unchanged. A
singular or numerically unusable Poisson block must fail the solve rather than
regularize the physical operator. This is separate from the explicit,
norm-scaled shift used only by the outer spectral-transform preconditioner.
The policy is exposed as
`SLEPcTinyGyrotropicModalEigenResult::poisson_factorization_shift_policy` and
serialized in modal diagnostics. The implementation owner is
`backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` +
`solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context`; the regression assertion
is in `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` +
`executes_native_sparse_matshell_above_dense_bound`.

The outer shift-invert preconditioner has two explicit size regimes. For a
real-split magnetic Schur dimension no larger than 512, the CPU lane
materializes the exact matrix-free Schur action and factors
$S(\mathbf k)-\sigma B$ after norm scaling. This bounded validation regime
contains the same dynamic-demag feedback as the operator and does not replace
the operator or change any eigenpair acceptance residual. Above 512, the lane
retains the sparse magnetic-only approximation
$-iA_{qq}(\mathbf k)-\sigma B$; that scalable regime remains unqualified for
the A1 campaign until a demag-aware block preconditioner and convergence
evidence are available. Diagnostics distinguish the regimes through
`factorization_shift_policy`. The cutoff is a resource bound, not a physical
or accuracy threshold.

For the CPU K0 frequency-window path, small real-split systems of at most
512 degrees of freedom cache the unshifted normalized Schur action once in
the window-owned operator context. Each spectral transform duplicates that
cache and subtracts its own shift times the normalized mass matrix. This
retains demag feedback in the preconditioner without repeating the basis
applications for every subwindow. Larger windows keep the magnetic-only
preconditioner; the existing single-shift reference cap of 8192 is unchanged.
The cache has the lifetime of one frequency window and is destroyed with its
operator context. Failed cache construction or duplication fails closed.
Neither the eigensolver MatShell nor the physical residual and coverage gates
are replaced. Source owner:
`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` +
`create_production_cached_window_preconditioner`. Regression owner:
`backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` +
`FrequencyWindowRetainsDemagInBoundedCachedPreconditioner`. The coupled fixture
retains a known Schur frequency while testing multiple shifts and fresh window
contexts. This change is source-only until its managed build and runtime checks
complete; the temporary native-test compilation prohibition remains in force.

For a standalone Gamma control, the DE-SMOKE input requests
`PeriodicBC(["x_faces", "y_faces"])` and
`magnetostatic_bc="periodic_airbox_k0"`. The Floquet-airbox request is
reserved for a nonzero single wavevector or an explicit path containing
nonzero wavevectors; the path dispatcher resolves its Gamma samples to the
K0 operator. This distinction changes authoring legality, not the physical
periodic trace at zero wavevector, and must be preserved in Python-to-IR
regressions. The owner is `examples/fem_de_smoke_numeric.py` +
`study.stages.add_eigenmodes`; regression:
`scripts/test_de_smoke_model.py` +
`test_de_smoke_preserves_physical_problem`. It does not certify K0 window
coverage or convergence.

### 3.7 FEM GPU ownership and truthful lane names

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

### 3.8 FDM and hybrid interpretation

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
|---|---|---|---|---|---|---|
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
| `add_eigenmodes.k_vector` | `tuple[float, float, float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Legacy single-$\mathbf k$ alias; finite three-vector; conflicts with a non-equivalent `k_sampling`; `periodic_airbox_k0` requires exact zero. | Single Bloch wave vector. | FEM CPU authoring; bounded nearest-frequency Floquet-airbox demag route is source-visible and runtime-unvalidated; GPU remains unsupported | `study.k_sampling={"kind":"single","k_vector":[...]}`. |
| `add_eigenmodes.k_sampling` | `object \| None` | `None` | $1$ | Must lower through `coerce_k_sampling`; a simultaneous non-equivalent `k_vector` is rejected. | Single point, path or declared wave-vector sampling. | FEM CPU authoring; bounded nearest-frequency Floquet-airbox demag route is source-visible and runtime-unvalidated; GPU remains unsupported | `study.k_sampling`. |
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

(nearest-floquet-selected-route)=
#### 4.3.1 Bounded nearest-frequency Floquet diagnostic

The FEM CPU capability gate now admits a bounded, selected-only nearest-frequency
request for a nonzero-$k$ Floquet airbox with dynamic demagnetization. The request
must keep the existing physical contract: `full_2x2`, demagnetization enabled in
both the plan and operator, `damping_policy="ignore"`, a Poisson/Robin
magnetostatic realization, `SharedDomainMeshWithAir`, valid magnetic and airbox
periodic pair maps, and at least one nonzero sample. The runner classifies the
periodic node pairs against the tet4 element markers and requires both a
nonzero magnetic-pair count and a nonzero airbox-pair count; nonempty metadata
lists alone are insufficient. These guards select the
existing native MFEM/SLEPc shared-domain Floquet sparse route; they do not
introduce a second operator or a CPU fallback. The public engine name retains
the historical `FloquetAirboxCpuSchurSlepc` label, but its nonzero-$k$ call
chain is `modal_eigen_solver.cpp` -> `production_cpu_modal_eigen.cpp` ->
`floquet_modal_solver.cpp` and `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context`.
The retained two-argument compatibility entrypoint
`solve_floquet_shared_domain_sparse_modal_spectrum` only delegates to that
owner with `nullptr`; one-window calls pass their explicit reusable context.
The descriptor Poisson Schur writer in
`poisson_airbox_schur_matshell.cpp` remains the separate $k=0$ branch.

`target="nearest"` carries one positive `target_frequency` in Hz. A single-$k$
request and a multi-$k$ path use that same scalar target for every sample. The
native request transfers the target kind and frequency unchanged, and orders
accepted candidates by their distance from the target angular frequency. The
original full descriptor, magnetic-block and potential-block residual checks and
their existing tolerance remain the acceptance gate.

Nearest is a diagnostic selection mode. Its artifacts must report
`spectrum_completeness="selected_only"` and `window_complete=false`; a selected
mode is not a complete frequency window, a complete spectrum, or a convergence
claim. The `frequency_window` route remains the owner of window coverage and
window-completeness evidence. The first planned diagnostic scope is five separate
CPU points (Gamma and signed DE/BV controls) using the analytic $n=0$ slab value
only as a search target. That analytic value is a comparison input, never a
replacement operator or an acceptance oracle. Managed runtime, residual,
mesh/airbox convergence, signed-path completeness, COMSOL A1 parity and GPU
qualification remain open.

The legacy native `complete` flag describes whether the solver envelope
finished; it is not a spectrum/window certificate. Nearest additionally
publishes `solve_complete`, derived from the result status, so consumers do not
infer coverage from that legacy flag. `spectrum_completeness` and
`window_complete` remain the explicit coverage fields for this route. The
frequency-window producer keeps its existing `complete` and
`window_completeness` contract.

The producer boundary for this metadata is
`backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`, after the
Floquet owner has selected the nearest mode. Its native diagnostics and result
envelopes must carry `target_kind="nearest_frequency"`, the finite requested
`target_frequency_hz`, `spectrum_completeness="selected_only"`,
`window_complete=false` and the status-derived `solve_complete` field. These
fields describe the actual selected solve; they are not inferred by the runner
from a target request. The direct descriptor Poisson Schur branch is only the
$k=0$ route and is therefore not the producer of nonzero-$k$ nearest metadata.
The frequency-window producer keeps its separate `window_completeness`
contract and must not be marked selected-only by this route. Native compilation
and runtime evidence for this producer remain pending.


### Kanoniczne klasy redukcji periodycznej FEM CPU

Generator `modal_shared_domain_equivalence_classes` w
`crates/fullmag-runner/src/fem/eigen_shared_domain_geometry.rs` musi wybierać
najmniejszy globalny numer węzła jako reprezentanta każdej spójnej klasy
periodycznej. Numery zredukowane są kolejnymi liczbami od zera w kolejności
rosnących reprezentantów; klasy magnetyczne mają własną taką numerację.
Kierunek i kolejność par nie zmieniają żadnej z map. Węzły niemagnetyczne
zachowują sentinel `u32::MAX` w mapie magnetycznej; klasa łącząca węzły
magnetyczne i powietrza pozostaje błędem. To indeksowanie jest bezwymiarowe.

Ta reguła musi obowiązywać przed złożeniem operatorów i przed wiązaniem mapy
z certyfikatem v6. `validate_modal_reduction_map` w
`crates/fullmag-runner/src/fem/eigen_certificate.rs` pozostaje niezależną
kontrolą zgodności; nie wolno go osłabiać ani permutować wyłącznie metadanych
po złożeniu macierzy. Zmiana nie modyfikuje faz Floqueta, słabej postaci,
jednostek SI, Python API, ProblemIR, schematu certyfikatu ani progów residualu.
Dotyczy przygotowania map FEM CPU; nie stanowi dowodu wykonania FEM GPU,
nie zmienia realizacji FDM CPU/GPU. Regresje źródłowe i niezależny replay
siatki nie zastępują ponownego managed pilota Γ oraz niezerowego k.

### Seria signed-k DE/BV do 25 rad/µm

Dla jednorodnego filmu 10 nm z demagiem, M0 i polem w osi x, DE używa
wektora w osi y, a BV w osi x. Seria `signed-13` zadaje osobne obliczenia
dla 0 oraz obu znaków wartości 2, 5, 10, 15, 20, 25 rad/µm w każdej
konfiguracji. To 13 rzeczywistych punktów na konfigurację; znak jest zachowany
w Python→ProblemIR, fazie Floqueta, CSV, odbiorze i na osi wykresu.
Punkty ujemne nie powstają przez odbicie dodatnich częstotliwości.
Referencja jednorodnego symetrycznego filmu jest wzajemna, lecz symetrię
wyników FEM należy zmierzyć, a nie narzucić. Zakres ten dotyczy konkretnej
geometrii bez DMI; nie stanowi ogólnego założenia wzajemności.

Kontroler `validation_cases` w `scripts/run_nonzero_k_validation_controller.py`
zachowuje kontrolę Γ, osobne zaakceptowane receipty i serie zbieżności warstw
3/6/9 dla dodatniego k25. Domyślna seria siedmiu przypadków pozostaje dostępna.
Nowa seria signed-k używa L2/t3, tych samych SI materiału i tolerancji;
wykres nie zastępuje bramki residuali, zgodności siatki, pól ani zbieżności.
Przy pierwszym nieudanym punkcie dalsze przypadki są zatrzymywane do diagnozy.

Odbiór signed-k wymaga zgodności hasha kontrolera z niezmienną kapsułą
managed buildu oraz ścieżki kapsuły w każdym receipcie. Raport musi znajdować
się pod identyfikatorem własnego joba. Osobny `collect_control` w
`scripts/collect_de_bv_thickness_comparison.py` weryfikuje wszystkie sześć
przypadków zbieżności i Γ; jego pełny wynik i hash konfiguracji są wymagane
w raporcie signed-k. To dowód odbioru, nie automatyczny dowód zbieżności:
różnice częstotliwości i profili nadal wymagają oceny. Porównanie signed k
zachowuje tę samą tolerancję numeryczną co walidator CSV.

Nie wprowadza to nowej realizacji GPU/FDM ani zmiany schematu ProblemIR.

(implementation-mapping)=
### 4.4 Runtime lifecycle and provenance

The accepted equilibrium artifact produces one `LinearizationState`; modal and
driven requests consume it without hidden recomputation. Failed or interrupted
runs retain the requested/resolved plan, solver phase, latest true residual,
stop reason, partial progress, and available diagnostics.

Modal solver progress is diagnostic telemetry, not a physical observation.
A dimensionless solver residual must never populate `max_h_eff` (A/m), torque,
energy or magnetization. CLI modal/heartbeat lines expose phase, exact solver
identity, subwindow counters and solver residual separately. Missing solver
identity remains `unknown`; absence of a LOBPCG flag is not evidence for a dense
algorithm or any CPU/GPU lane. Progress identity flags in `fem_eigen_progress`
are not physics values or a terminal mode-residual certificate. Physical scalar
rows remain governed by their existing observation cadence. Current physical
resources report absence during a modal callback instead of relabeling a
previous observation as current. Historical scalar/table views retain true
measurements and filter diagnostic-only rows without rewriting archived input
or renumbering source cursors. Realtime scalar samples require an accepted
scalar revision change.

An illustrative modal envelope uses the artifact damping convention, not a
measured drive/detector response. For `exp(i omega t)`,
`damping_rate_hz = Im(omega)/(2*pi)` is the Lorentzian HWHM in Hz;
FWHM is twice that value. In the illustrative profile
`1 / ((f - f_mode)^2 + damping_rate_hz^2)`, both frequencies and the
half-width are evaluated in Hz before display-axis conversion. Unknown axis
units are unsupported. Normalization does not infer residues, oscillator
strength, FMR or BLS intensity.

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
| Phase-aware mode kinematics | common FEM | `backends/fem/src/frequency_domain/mode_kinematics.cpp` + `frequency_hz_from_omega_rad_s` | Convert the phase-signed angular frequency produced by `map_eigenvalue`; the mapper applies exact-zero default classification and retains caller-supplied absolute tolerance without asserting nullspace certification. | Focused source regression prepared; runtime and physical nullspace qualification pending |
| Stage-first modal authoring | common | `packages/fullmag-py/src/fullmag/world.py` + `eigenmodes_stage` | Capture the modal stage specification without executing it. | source tested; runtime unvalidated |
| Stage-first driven authoring | common | `packages/fullmag-py/src/fullmag/world.py` + `frequency_response_stage` | Capture frequency samples, drive and solver policy. | source tested; runtime unvalidated |
| Modal Python validation/lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class Eigenmodes` | Validate modal inputs and serialize canonical study IR. | source tested |
| Driven Python validation/lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class FrequencyResponse` | Validate driven inputs and serialize canonical study IR. | source tested |
| Krylov policy validation/lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class FrequencyResponseSolverPolicy` | Validate method, preconditioner and iteration controls. | source tested |
| Canonical harmonic action | common native | `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp` + `apply_Aomega` | Apply $A_\omega=\mathrm{i}\omega B_\alpha-L$ to a state. | source visible; managed physics unvalidated |
| Real-frequency rotation | FEM CPU/GPU algebra | `backends/fem/src/frequency_domain/real_frequency_rotated_pencil.cpp` + `assemble_real_frequency_rotated_pencil` | Assemble the real-split target on the physical frequency axis. | source tested; managed physics unvalidated |
| Real-frequency SLEPc adapter | FEM CPU modal adapter | `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` + `solve_slepc_gyrotropic_modal_eigen_with_matrices` | Lift the real stiffness/gyrotropic pencil to $R(A)y=\omega R(\mathrm{i}G)y$, apply the signed shift on the physical frequency axis, and map the split vector back to the complex tangent mode. | source contract tested; managed runtime unvalidated |
| Native shared-domain Floquet selected spectrum | FEM CPU, nonzero-$k$ dynamic-demag modal route | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` | Apply the reduced Schur action as a matrix-free SLEPc operator; the inner Poisson `KSPPREONLY`/LU uses `MAT_SHIFT_NONE`. Normalize the magnetic and gyrotropic pencil blocks by the same nonzero scalar. The separate shifted magnetic block is an LU preconditioner only. The EPS absolute prefilter currently uses an uncalibrated $10^{-3}$ multiplier; acceptance checks the original reduced magnetic and potential residuals and is not full descriptor certification. | Runtime-only builds #133–#136 succeeded. #133 produced a candidate with magnetic residual $2.17\times10^{-7}$, rejected at the requested $10^{-8}$. #134–#136 with EPS cutoff $10^{-11}$ produced no converged pair; the measured `ncv=32` experiment did not remove stagnation. KSP true-residual measurement and tolerance calibration remain pending. Physical qualification `NOT VERIFIED`. |
| Floquet tangent source assembly | FEM CPU Floquet source | `backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp` + `assemble_floquet_bloch_scalar_tangent_source` | Assemble the magnetization-to-scalar-potential source element-locally, including the shifted-envelope $\mathrm{i}\mathbf{k}\cdot\mathbf{m}$ term and magnetic-element mask. This is a source assembly boundary, not a production nonzero-$k$ demag qualification. | source contract tested; managed assembly and physics unvalidated |
| CPU Schur selected spectrum | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Solve and certify the source-visible descriptor reduction. | source tested; managed qualification absent |
| GPU PETSc/SLEPc selected spectrum | FEM GPU | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Declare the GPU modal adapter. | source tested; device qualification absent |
| Modal payload ownership | common native | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `validate_native_modal_request_payload_ownership` | Reject ambiguous or missing operator payload ownership. | source tested; runtime unvalidated |
| Driven method fail-closed policy | common runner | `crates/fullmag-runner/src/frequency_response.rs` + `frequency_response_solver_method_rejection_reason` | Reject unavailable method/device combinations before fallback. | source tested |
| Native CPU driven boundary | FEM CPU | `crates/fullmag-runner/src/frequency_response.rs` + `try_execute_fem_frequency_response_native_production_cpu` | Build the native CPU response request and preserve explicit failure. | source tested; managed physics unvalidated |
| Shared-domain Floquet modal frame guard | FEM CPU modal/demag | `backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp` + `validate_periodic_tangent_frames` | Before building the magnetic phase constraint, require finite and matching $m$, $e_1$, and $e_2$ components on each paired active magnetic seam (maximum component mismatch $10^{-10}$); reject unsupported tangent-frame rotations instead of applying an identity component map. | source regression added; managed runtime and physics unvalidated |
| Floquet phase/frame checks | FEM response | `backends/fem/src/frequency_domain/driven_response_solver.cpp` + `validate_driven_response_floquet_phase_constraints` | Validate phase loops, tangent-frame matching and drive consistency. | source tested; demag-k bridge source-visible, managed/physics unvalidated |
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
| Temporal phasor branch | C ABI generic dense and CSR providers, nearest and window selections, both conventions; compare top-level and every mode's signed lambda, frequency, omega, and branch | all generic modal result mappings |
| Nonnormal response | left/right modal and Petrov-Galerkin reduced oracles | damped/nonconservative ROM |
| Floquet | phase-plus-frame cycle, k=0 periodic parity, supercell, exchange `k^2` | nonzero-k claims |
| Spectrum | selected-window completeness, finite-mode filtering, conjugate pairing | interior-window eigensolve |
| CPU/GPU | identical assembled input, result parity, residency and transfer audit | GPU qualification |
| Product truth | no hidden fallback; complete artifacts and bounded `validated_scope` | capability promotion |

Analytical expected values are verifier inputs only. They never construct the
operator under test. Native FEM runtime qualification must use repository
container-backed `just` recipes; host-only checks cannot promote capability.

The focused `modal_eigen_contract_test --modal-slepc-phase-convention` mode
must run the actual generic SLEPc provider for dense and CSR payloads under
both temporal conventions and both nearest-frequency and frequency-window
requests. It checks top-level and every returned mode's signed eigenvalue,
frequency, angular frequency, branch sign, and actual `phasor_convention`
label. Tiny validation continues to map the request convention, and the
contour-minus rejection remains covered by the full contract test. The focused
mode fails when MFEM or SLEPc is unavailable and prints the exact marker
`PASS: modal_slepc_phase_convention_contract` only after those checks pass.
Focused GHA [37862208552](https://github.com/MateuszZelent/fullmag/actions/runs/37862208552)
passed on commit `39399b8c60aea099719b325114f229f2cba7a40b` with actual
MFEM/SLEPc and CUDA disabled. It covers eight C ABI combinations, each selecting
one physical mode. Multimode output, demag physics, and release qualification
remain separate and **NOT VERIFIED** by this focused fixture.

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
- [ ] Nonzero-k dynamic demag and DMI managed-runtime and physics-qualified

(limitations)=
## 7. Known limits and deferred work

This note is a contract and claim freeze, not solver promotion. The real-axis
rotation, Poisson-airbox weak-form assembly, CPU Schur boundary, CPU
Floquet/airbox dynamic-demag path, GPU adapter and public requests are
source-visible, but current-snapshot managed qualification of finite descriptor
handling, production reduced response, device-resident Krylov, general GPU
modal eigensolve, damping/nonuniform textures and physical K0 demag remains
absent. The bounded nearest-frequency nonzero-k Floquet/demag request is now
source-visible and selected-only, but its managed runtime, residual and physics
qualification are still absent. Nonzero-k dynamic demag is therefore gated as
unqualified, nonzero-k DMI remains
unavailable, and fully 3D periodic demag remains unavailable; all unsupported
combinations fail closed.

The native shared-domain Floquet modal implementation keeps the Schur action
in the SLEPc shell and uses `MAT_SHIFT_NONE` for the inner Poisson LU that
computes $P(\mathbf k)^{-1}$. Its separate explicit shifted magnetic matrix is
an approximate LU preconditioner for the outer spectral transform only; its
norm-derived nonzero shift must not enter the generalized pencil or original
block residual. The first managed nonzero-$k$ smoke reached candidate filtering
after the outer LU zero pivot was removed, but no mode passed the reduced
residual gate. Candidate residual breakdown was not present in that build's
diagnostics. Local source changes add separate EPS, magnetic-block and
potential-block measurements, count candidates with fully evaluated
residuals, serialize unmeasured metrics as `null`, and now forbid an inner
Poisson factorization shift. Those changes have not been rebuilt or executed
through the managed runner. Until a new managed run passes, this route remains
unqualified.

The `target_frequency` plus `frequency_window` serialization loss documented
in section 4.2 is an authoring/round-trip limitation. The policy vocabulary
`modal_reduced` and `gpu_device_krylov` is also broader than currently
qualified runtime scope; accepting an enum in Python or IR is not executable
or production evidence.

### Managed $k_2$ residual checkpoint — 2026-09-23

Build job `d4a26468c5124354b9956ac5ddb92aef` finished successfully as a
runtime-only `fem-cpu-slepc-runtime-v1` build for commit
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c` and source snapshot
`8467417fdf6ce3265f00c5dd61b5390b1c32352dd6475421d39b74344b89d052`.
The runtime attestation reported native FEM CPU available; no unit tests were
compiled or run by that recipe.

The managed `de-smoke-k2` run used FEM CPU/double/SLEPc, dynamic Floquet demag,
$\mathbf k=(0,2\times10^6,0)\,\mathrm{rad\,m^{-1}}$, 1980 nodes, 5720
tetrahedra, and 1195 Floquet pairs. It reached the modal solve and found an
in-window candidate at $9.7233362727\,\mathrm{GHz}$, but produced no accepted
mode. The magnetic original-block residual was
$2.1678405358\times10^{-7}$ against the requested $10^{-8}$ gate; the
potential residual was about $1.42\times10^{-14}$. No dispersion CSV row or
plot is valid from this run.

The diagnostics exposed a convergence-scale mismatch: the adapter used
`EPS_ERROR_RELATIVE`, whose SLEPc definition is $\lVert r\rVert/|\lambda|$,
and compared it with a dimensionless original-block residual. For this
generalized SI pencil, the reported EPS value was $5.72\times10^{-20}$ while
the physical magnetic residual was $2.17\times10^{-7}$. At that checkpoint,
the source asked SLEPc to stop on an absolute true residual of the commonly normalized pencil,
with internal tolerance
$\max(100\epsilon_{\rm machine},10^{-2}\,\mathrm{rtol}_{\rm requested})$.
The reported absolute EPS residual is diagnostic only; final mode acceptance
still uses the original magnetic and potential residuals and the requested
relative tolerance. This correction is **source changed, runtime not yet
verified**. See the [SLEPc convergence-test documentation](https://slepc.upv.es/release/manualpages/EPS/EPSSetConvergenceTest.html),
[true-residual documentation](https://slepc.upv.es/release/manualpages/EPS/EPSSetTrueResidual.html),
and [error-type definitions](https://slepc.upv.es/release/manualpages/EPS/EPSErrorType.html).

The same run now exported `H_demag` and `demag_phi`. The static periodic-seam
diagnostic passed for six boundary-pair groups with zero measured magnetization,
potential, field and normal-flux mismatch, and the recomputed final-state
linearization certificate matched. This is a static $k=0$, uniform in-plane
equilibrium check only; it does not qualify the dynamic nonzero-$k$ demag
operator or the failed modal solve. The LLG qualification artifact remains
`not_evaluated`.

### Managed $k_2$ EPS cutoff follow-up — 2026-09-25

Runtime job `60a2a77007e7462aa10bba1d6732588f` was accepted as a
runtime-only FEM CPU/SLEPc build (14 artifacts, exit 0). Its first pilot
`8787e6eac6434ef9a2ffcc3b1702c65f` used the SLEPc default limit of 100
iterations. A follow-up run `ca448b26d8934e849c8bb50460e92612` used the same
runtime, the versioned DE-SMOKE input from commit
`7a8b57cf1ca6b64902cdee60945cebdda9e2bd4c`, and an explicit 500-iteration
limit. Both frequency subwindows still ended with
`EPS_DIVERGED_ITS` (`-1`) and zero converged or accepted modes. Their first
unconverged absolute true-residual estimates were respectively
$3.4957520\times10^{-9}$ and $6.0189714\times10^{-9}$, unchanged from the
100-iteration attempt. The EPS cutoff was $10^{-10}$, while the independent
requested physical residual gate was $10^{-8}$. The run therefore produced
no frequency, CSV row, or valid plot. Increasing the iteration limit alone
did not resolve the solve.

The DE-SMOKE request used `include_demag=true`, nonzero
$\mathbf k=(0,2\times10^6,0)\,\mathrm{rad\,m^{-1}}$, and reached the
`floquet_shared_domain_sparse_matshell` operator with 1195 Floquet pairs. This
proves the request reached the intended dynamic-demag modal path, not that its
eigenmode was accepted or physically validated. The next source revision sets
the EPS absolute true-residual prefilter to
$\max(100\epsilon_{\rm machine},\mathrm{rtol}_{\rm requested})$. This only
controls which Ritz candidates SLEPc returns; the independent original
magnetic and potential residual checks remain the acceptance gate. The
revision still requires a managed rebuild and another numerical pilot.

### Managed $k_2$ physical-residual follow-up — 2026-09-25

Runtime job `059f9538791346289316580c94ce4a36` (#133) succeeded as a
runtime-only FEM CPU/SLEPc build for source digest
`9c1312cad6b253fa0345e601de42d2fc2b11aeda0e497e934770a8bbb2714f6d` and
snapshot SHA `11a754ab43488ba74a9684b4c9dddea72239089604c0787108647f7d9535ac1a`.
The first `de-smoke-k2` run on that runtime used the committed standalone model
from `7a8b57cf1ca6b64902cdee60945cebdda9e2bd4c` and ended without an accepted
mode. The controlled repeat used model commit
`673dc10b2704a0e12e193f145a86b33ae53ca13e`, which raised only the outer
iteration limit from 500 to 2000 while leaving the requested physical gate at
$10^{-8}$. Its run directory is
`storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/059f9538791346289316580c94ce4a36/comsol-dispersion/f683308e79b449e7a2db987253ae9535`.

The repeat again ended with `EPS_DIVERGED_ITS` and zero accepted modes. It
returned two unaccepted candidates near $9.7233363\,\mathrm{GHz}$; their
absolute true residual was $3.4957520\times10^{-9}$ while the reconstructed
magnetic-block relative residual stayed at $2.1678405\times10^{-7}$, above the
requested algebraic gate. The paired potential residual was
$1.2442\times10^{-14}$; the maximum across candidates was
$1.4175\times10^{-14}$. Increasing the iteration limit alone did not improve
the original residual. The ratio between the reported residual measures shows
that EPS absolute convergence does not guarantee the requested block residual.
It does not establish whether that requested tolerance is necessary for a
specified frequency accuracy.

The source now sets the EPS prefilter to
$\max(100\epsilon_{\rm machine},10^{-3}\,\mathrm{rtol}_{\rm requested})$ and
keeps acceptance at the requested original-block relative residual. This
heuristic was subsequently built and run in #134–#136. It did not resolve the
plateau. No nonzero-$k$ mode is accepted at the requested tolerance. A plot of
unaccepted candidates must explicitly identify them as diagnostic data; it
cannot certify dispersion or silently change historical run status. The next
step is the tolerance calibration in section 3.2, not an unchanged rebuild.

The first follow-up runtime build was queued as job
`f29dad61e46048ff934ada17e75cde53` with source digest
`d90df5fb5da8eb13cd15326c1b44b527cd54dbd571645ca1ab636ffeab7e84a0` and
snapshot SHA `8a7b9ff2e8c91609a925055d31ee51ae3c3135090bef40873c40c3336c6ecd5f`.
The build later succeeded. The latest #136 pilot also completed but returned
no converged pair with `ncv=32`. The audit linked in section 3.2 records the
exact job/run identities and the unresolved true-residual measurements.

The next source revision adds a direct diagnostic of the **last** shift-invert
linear solve: it evaluates the actual shifted shell on the returned solution
and records $\|b-A_\sigma x\|_2$, $\|b\|_2$, their ratio, and PETSc's resolved
preconditioning side and norm type. This is distinct from
`KSPGetResidualNorm`; it does not bound all earlier linear solves. For a
reconstructed candidate, the diagnostic also records the imaginary part of
the rotated eigenvalue, the original magnetic residual before projecting that
part away, and the ratio of the physical-mode norm to the real-split vector
norm. These measurements have no runtime evidence until a new managed build
and pilot run; the acceptance rule and historical statuses remain unchanged.

For an explicitly requested small-problem diagnostic, the source also
materializes the original Schur action
$S=A_{qq}-A_{q\phi}P^{-1}A_{\phi q}$ in its real-split representation and
compares it with the production shell before solving $(S,B_{qq})$ by dense
LAPACK without shift-invert. SLEPc 3.24 exposes this as `STSHIFT` with zero
shift, not as a separate `STNONE` type. It uses a separate unshifted Poisson LU and is
bounded to at most 512 real-split magnetic unknowns. The direct eigenpair's
raw and projected original-block residuals are reported separately. This
oracle does not supply a production mode or change acceptance, and it has
no managed runtime evidence yet; the C1 build snapshot predates this source.

The managed C1 runtime build #137 succeeded, but its first DE-SMOKE $k_y=2
\times10^6\,\mathrm{rad\,m^{-1}}$ pilot crashed with PETSc signal 11 after
`EPSSolve`. A bounded one-iteration diagnostic under Valgrind localized the
invalid read to the new true-residual `MatMult`: the RHS/solution borrowed
from SLEPc's KSP after `EPSSolve` were no longer valid. The source now copies
the last RHS and solution in a `KSPSetPostSolve` callback while those vectors
are live, then evaluates the shifted residual from the copies. A later source
review also retained an owned PETSc reference to the shifted `Mat` until that
measurement; otherwise its borrowed pointer could outlive the KSP owner.
The vector-copy correction is in build #140, while the matrix-reference change
still requires a subsequent managed build and pilot. Neither the physical tolerance
nor scientific qualification changed. The diagnostic also reported earlier
MFEM sparse-matrix writes outside allocated objects during initialization;
that separate memory finding remains under investigation.

For tolerance calibration only, DE-SMOKE single-k and multi-k pilots can request private,
independent diagnostic values for the EPS absolute true-residual prefilter
(`FULLMAG_FLOQUET_EPS_PREFILTER_ABS`) and the shifted KSP relative tolerance
(`FULLMAG_FLOQUET_SHIFTED_KSP_RTOL`). Each accepts a bounded enumerated value;
the request records it, and solver diagnostics record the resolved numeric
settings. Neither changes the physical original-block acceptance tolerance
unless the separate `solver_rtol` input is explicitly changed. This permits
fixed-physics comparisons of returned Ritz candidates and inner-solve quality;
it is not a calibrated accuracy policy or a production fallback.

The #141 runtime resolved left-preconditioned GMRES and reported a configured
residual near $10^{-24}$ while direct evaluation of its last shifted system
gave $\|b-A_\sigma x\|_2/\|b\|_2\approx 5.10\times10^{-7}$. Here $b$ is the
right-hand side of that one shift-invert solve, $A_\sigma$ its exact Schur
operator, and $x$ the returned vector; all have the same normalized SI pencil
scaling. This is an algebraic residual, separate from the reconstructed
magnetic and potential mode residuals. The bounded C2 dense oracle on the
same operator found $9.723336314058123$ GHz at $k_y=2\times10^6\,\mathrm{rad,m^{-1}}$
with magnetic residual $1.68\times10^{-14}$, but the iterative route still
returned no mode. For the next solver experiment, FEM CPU sets right GMRES
preconditioning and explicitly requests `KSP_NORM_UNPRECONDITIONED`. PETSc
[documents this supported GMRES norm/side pair](https://petsc.org/release/src/ksp/ksp/impls/gmres/gmres.c.html).
The configured inner tolerance and the physical $10^{-8}$ original-block
acceptance criterion remain unchanged. Right preconditioning removes the
left-preconditioned norm ambiguity; it does not by itself certify a true
residual for every inner iteration, repair an MFEM ABI mismatch, or qualify
the dispersion. Managed build, pilot and memory checks remain required.
Build #142 resolved right-preconditioned GMRES with the unpreconditioned norm,
but its $k_y=2\times10^6\,\mathrm{rad\,m^{-1}}$ pilot still reached 2000 EPS
iterations in each window without a converged mode. The final independently
recomputed linear relative residuals were $3.30\times10^{-6}$ and
$5.01\times10^{-7}$, while the GMRES recurrence reported absolute norms near
$10^{-25}$. PETSc documents that
[`KSPGetResidualNorm`](https://petsc.org/release/manualpages/KSP/KSPGetResidualNorm/)
for GMRES may be an approximation rather than a direct evaluation of
$b-A_\sigma x$.
The next numerical experiment uses modified Gram--Schmidt orthogonalization
for this right-preconditioned GMRES, following PETSc's
[orthogonalization guidance](https://petsc.org/release/manualpages/KSP/KSPGMRESModifiedGramSchmidtOrthogonalization/).
This can reduce loss of Krylov-basis
orthogonality, but is not assumed to fix the discrepancy; the same physical
$10^{-8}$ mode gate and independently recomputed linear residuals decide the
outcome. The experiment applies only to the FEM CPU Floquet modal lane; FDM
and FEM GPU semantics are unchanged. It changes no Python or `ProblemIR`
parameter, and a managed source snapshot plus pilot receipt must identify
which binary ran it. If the true residual plateau persists, inspect the
conditioning and repeatability of the exact Schur MatShell and its Poisson
inverse before changing tolerances.

The next C1 source revision also evaluates $\|b-A_\sigma x\|_2/\|b\|_2$ in
the KSP post-solve callback for every completed inner solve, recording the
sample count, measurement failures, and maximum. This measures completed
linear solves rather than every GMRES iteration and remains diagnostic; a
missing measurement cannot silently become a zero maximum. Runtime evidence
for these new fields is pending a subsequent managed build.

Build #143 supplied that runtime evidence. Its MGS pilot at
$k_y=2\times10^6\,\mathrm{rad\,m^{-1}}$ reduced the final true relative
KSP residual in the first subwindow from #142's $3.30\times10^{-6}$ to
$4.14\times10^{-8}$, but both subwindows still reached 2000 EPS iterations
without an accepted mode. Across 32016 completed inner solves per subwindow,
the largest measured true relative residuals were $1.05\times10^{-4}$ and
$2.50\times10^{-5}$, with zero measurement failures. Relaxing only the
diagnostic EPS prefilter to $10^{-8}$ exposed a $9.723336314$ GHz candidate,
whose original magnetic residual was $2.80\times10^{-7}$; the unchanged
$10^{-8}$ physical gate correctly rejected it. Thus neither the last KSP
solve nor EPS's normalized absolute residual certifies the physical mode.

Build #144 tested classical Gram--Schmidt with refinement on every GMRES
orthogonalization step, using PETSc's
[`KSPGMRESSetCGSRefinementType`](https://petsc.org/release/manualpages/KSP/KSPGMRESSetCGSRefinementType/).
The managed $k_y=2\times10^6\,\mathrm{rad\,m^{-1}}$ pilot again returned zero
accepted modes. Its last true relative KSP residuals were $8.74\times10^{-7}$
and $1.09\times10^{-6}$, while the maxima across completed inner solves were
$8.59\times10^{-5}$ and $5.83\times10^{-5}$. With only the diagnostic EPS
prefilter changed to $10^{-8}$, a $9.723336314$ GHz candidate had original
magnetic residual $2.60\times10^{-7}$ and was rejected by the unchanged
$10^{-8}$ physical gate. Thus this orthogonalization change did not cure the
inner-solve discrepancy.

The next bounded FEM CPU experiment controls the GMRES restart length using
PETSc's [`KSPGMRESSetRestart`](https://petsc.org/release/manualpages/KSP/KSPGMRESSetRestart/).
The default length is 30, whereas the observed projected-convergence point
was about 13--15 iterations. Diagnostic choices 8, 10, 12 and 16 force an
earlier restart; the resolved value is reported with the subwindow solver
policy. The experiment retains the same right preconditioning, shifts,
tolerances, original-block gate and measurement of each completed inner solve.

The shifted Floquet GMRES sets its default restart length to `8` and PETSc's
restart-breakdown tolerance to `2.0`, reporting both values. At every restart,
PETSc compares the explicitly recomputed residual with the recursive residual
against the residual norm at the beginning of the cycle. The Floquet Schur
`MatShell` contains a finite-tolerance inner Poisson solve, so the two residual
histories need not agree to the default factor `0.1`. The earlier value `1.0`
permitted residual replacement only while the discrepancy did not exceed the
complete cycle-start residual. Signed-path pilots with restart `8` reached roundoff
with observed discrepancy ratios `1.045` and `1.362` relative to the cycle-start
residual, so `2.0` permits those bounded transients and restarts from the rebuilt
residual. Larger discrepancies and actual KSP nonconvergence remain hard
errors. This numerical policy does not relax any scientific acceptance
criterion: every completed shifted solve is still measured independently, and
the reconstructed original magnetic and potential residuals remain the mode
acceptance gates.
This tests whether an earlier recomputation improves the true linear residual,
not whether the physical acceptance threshold should be relaxed. If it does
not, the shifted Schur conditioning and the preconditioner's omission of
demagnetizing feedback require direct investigation.

#### Failure-only shifted-KSP convergence probe

The native Floquet convergence callback now keeps a bounded scalar snapshot of
its own observations: callback count, iteration, recursive residual norm,
default convergence reason, and the reason after the unchanged true-residual
gate. Only when PETSc's default test proposes convergence does that same live
callback record $\|b_\sigma\|_2$, the recomputed
$\|b_\sigma-A_\sigma x_\sigma\|_2$, the applied threshold
$\max(\mathrm{atol},\mathrm{rtol}\,\|b_\sigma\|_2)$, and the residual to
threshold ratio. The vectors and PETSc handles are not copied into diagnostics.
These norms belong only to the internal shifted linear system; they are not
the original descriptor residual, the magnetic or potential residual, or a
scientific mode-acceptance metric. The latest callback and latest completed
true-residual probe keep separate iteration numbers because they can refer to
different callback invocations; the true probe also records its callback
ordinal so KSP iteration resets cannot associate it with a later solve's
recursive residual.

The failed EPS attempt records the NEV and NCV passed to `EPSSetDimensions`;
these are attempted settings, not queried or resolved dimensions. After a hard
`EPSSolve` error, the implementation copies only the cached scalar snapshot and
does not query EPS, KSP, DS, matrices, or vectors. A versioned
`shifted_ksp_failure_probe.v1` object is emitted only for
`floquet_slepc_solve_failed`. Unavailable observations are `null` with explicit
availability flags; they never mean zero residual or successful convergence.
The existing `ksp_last_*` fields continue to describe completed post-solve
measurements. This probe is diagnostic only: it does not change the callback
gate, restart-breakdown tolerance, failure status, or physical mode acceptance
criteria. Its original near-pole regression is separate from the shifted refill
fixture. The source regression is prepared; provider-backed execution remains
**NOT VERIFIED**.

Managed build #151 and run `b96f1961f51e4d34b038b689ee45caaf`
resolve that bounded experiment for
$k_y=2\times10^6\,\mathrm{rad\,m^{-1}}$. With restart length 10, SLEPc
accepted the $9.723336314057247$ GHz mode after three outer iterations. The
independent full projected weak-form residual was $2.18834\times10^{-10}$,
the reduced magnetic residual was $8.85558\times10^{-14}$, and the physical
potential residual was $1.25985\times10^{-14}$. All four periodic-seam
residuals and both dynamic-demagnetizing operator probes passed. The open-film
uniform-thickness $n=0$ reference is $9.725724281195415$ GHz, a difference of
$-2.387967$ MHz ($-0.0245531\%$). This establishes a numerically accepted,
unqualified nonzero-$k$ point; it does not replace mesh, airbox, spectral
coverage, mode-profile, or COMSOL A1 validation.

The managed pilot records restart length 10 explicitly in its request and
subwindow diagnostics. Multi-point DE-SMOKE runs may request the same bounded
restart value; the native solver default remains 30. The first 11-point run
then exposed a separate provenance defect before the first modal solve:
`AcceptedFemRelaxStageHandoff.v3` was parsed as
`AcceptedFemEigenEquilibriumHandoff.v1`. The path adapter now distinguishes
the schemas, verifies the stage-handoff content and topology identities, reads
the equilibrium-artifact and linearization-state digests from the solver
diagnostics, and constructs the eigen handoff used by subsequent $k$ points.
That correction still requires a fresh managed build and multi-point runtime
proof.

(scientific-bibliography)=
### K0 probe residual under cancellation — 2026-09-30

Managed build #167 passed all nine modal contracts. The signed-path pilot with
EPS prefilter $10^{-10}$ reached Gamma but the K0 in-plane operator probe
failed intermittently: signed potential/source actions were close to zero,
and their norm ratio was $0.08035$ although the mean field was approximately
$10^{-25}\,\mathrm{A/m}$ and the probe energy approximately $10^{-49}\,\mathrm{J}$.
This is a cancellation-sensitive diagnostic, not an eight-percent mode residual.

The K0 probe now measures the original potential equation using this scale:

```{math}
:label: eq-fem-k0-probe-componentwise-residual
\epsilon_{\phi,\mathrm{probe}} =
\max_i
\frac{|(r_\phi)_i|}
{\bigl(|P|\,|\phi|+|A_{\phi q}|\,|q|+|c\eta|\bigr)_i}.
```

Absolute values are componentwise. The gauge term is omitted for Dirichlet.
Zero numerator and denominator contribute zero; nonzero numerator with zero
denominator fails closed. The denominator has units $\mathrm{A\,m}$, matching
the original residual. This follows cancellation-safe scaling in
[LAPACK DLA_LIN_BERR](https://www.netlib.org/lapack/explore-html/d0/df7/dla__lin__berr_8f_source.html);
both coupled-block contributions participate because the source is a matrix
action. The physical operators do not change.

The unchanged probe gate is $10^{-8}$. Diagnostics identify
potential_residual_normalization=componentwise_absolute_csr_action and keep
the previous norm ratio in potential_action_relative_residual. Mean field,
energy identity, positivity and gauge checks remain independent. This change
applies only to the K0 diagnostic probe; modal full-block residuals and
Floquet acceptance retain their definitions.

Implementation: backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp
+ poisson_probe_componentwise_residual, used by
backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp
+ run_k0_demag_probe_sample. Regression:
backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
+ CertifiesChargeFreeProbeWithoutDividingByCancelledSource checks cancellation,
material defects, exact-zero rows, gauge and nonfinite inputs.
Managed execution of this correction and repetition of the signed path are
pending; source presence does not qualify the physics.

### Signed K0 spectral guards — source correction pending runtime

The #167 Gamma window accepted a $9.299249697$ GHz mode with full descriptor
backward error $4.20\times10^{-15}$, but eight refinement subwindows lacked a
lower positive-frequency guard. A lower endpoint below the fundamental mode
need not have a positive eigenvalue below it. Coverage must distinguish
published positive modes from evidence on the signed rotated-pencil spectrum.

For the existing empirical shift/NEV-refinement certificate, the source now
retains signed Ritz frequencies in $\mathrm{Hz}$ only after the same original
descriptor reconstruction and physical residual gate used for positive modes.
The coverage extrema use these untruncated certified guards. Negative guards
are never published as positive modes, never enter branch tracking, and never
change the requested mode count. Uncertified, unreadable or nonfinite Ritz
pairs still invalidate coverage. A one-sided saturated signed pool still fails.

This relies on the configured
[SLEPc EPS_TARGET_MAGNITUDE](https://slepc.upv.es/release/manualpages/EPS/EPSSetWhichEigenpairs.html)
selection and the existing overlapping target/NEV perturbation checks.
It is an empirical completeness certificate, not an exact spectral count.
A negative Ritz value without a reconstructed physical residual cannot certify
the endpoint. The real-split duplication and cluster-rank checks remain separate.

Owner: backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp +
solve_poisson_airbox_modal_eigen_cpu_schur. Native regression exercises a
fundamental-mode gap in a larger synthetic signed spectrum, while the
existing one-sided saturated-spectrum regression must remain fail-closed.
Managed execution of this correction is pending. The two SLEPc divergences in
the #167 Gamma schedule are an additional unresolved numerical gate.

### DE/BV single-point comparison at 25 rad per micrometre

The user-requested expanded-range check uses the same uniform 10 nm film,
40 nm lateral periodic cell, 2 micrometre air padding, 0.1 T bias along x,
Ms = 800000 A/m, A = 13 pJ/m and gamma0 = 221100 m/(A s).
DE uses k = (0, 25e6, 0) rad/m; BV uses k = (25e6, 0, 0) rad/m,
with equilibrium magnetization along x in both cases. Exchange and dynamic
Floquet demagnetization remain enabled. The wavevector is inside the first
cell Brillouin zone (pi / 40 nm). Both calculations retain the original
physical residual threshold 1e-8 and export complex mode fields.

The DE frequency window is 12--16 GHz; BV uses 8.5--12 GHz.
These are search intervals, not imposed eigenfrequencies. The existing
uniform-thickness n=0 analytical reference is evaluated only after solving.
Neither a close frequency nor a single-point match proves mesh/airbox
convergence or mode-profile identity. Managed execution is pending.
The standalone model input is versioned separately from the attested compiled
runtime; both identities must be preserved in the run receipt.

### Positive six-point DE/BV controls

The expanded single-point comparison is followed by six physical samples
k = 2, 5, 10, 15, 20 and 25 rad/micrometre for each orientation.
The equilibrium, mesh, SI material parameters, airbox and physical residual
threshold remain those of the preceding 25 rad/micrometre controls.
DE propagates along y and searches 8.5--16 GHz; BV propagates along x and
searches 8.5--12 GHz. One mode is requested at each sample, with native
subspace branch tracking and a common relaxed equilibrium.
Gamma is excluded from this control while its independent window/probe
corrections await managed execution; it remains required by the full plan.
All six samples need native descriptor/seam certification and demag probes.
A multi-point plot is diagnostic until profile identity and mesh/airbox
convergence are established. No analytical frequency is supplied to the solver.

### Per-mode block-certificate transport along a k path

Managed run 449fb744567a492db32b95329711ed08 computed six DE frequencies,
but its aggregate spectrum.v3 omitted block_residuals and failed validation.
The path adapter extracts per-mode quantities from each single-k native
spectrum. It must retain that same mode's block certificate through the
tracking/publication boundary, bound to sample index, raw mode index and
frequency in Hz. The aggregate diagnostic block is not an admissible
substitute: it can contain null values or describe another candidate.

The source correction copies the unchanged per-mode certificate through a
private native_mode_block_residuals diagnostic registry. Publication requires
one unambiguous matching sample/mode/frequency record; absent, duplicated or
mismatched records never synthesize certification. Both v2 and v3 carry the
same residual scope, tolerances and Floquet seam evidence. No residual is
recomputed or relaxed by this transport. Native regression and managed
execution remain pending; independent single-k solves provide diagnostic
points while the full multi-k gate remains open.

### Inner-solve diagnostics on an EPS error

FEM CPU queries the shift-invert KSP iteration count, reported norm and stop
reason before returning an EPSSolve error. A hard PETSc error may leave the
KSP stop reason at ITERATING; that value is reported as incomplete state,
not as convergence. The original EPS/MatShell error remains authoritative,
and no modes are accepted on this path. The reported KSP recurrence norm
does not substitute for an independently measured true residual. If the
post-solve hook never ran, the missing true residual remains unavailable.
This changes failure observability only, not the operator, tolerances,
window certificate, Python API or ProblemIR.

### Signed single-point DE/BV control

The standalone symmetric uniform-film fixture admits single points at
positive and negative 25 rad/micrometre along the DE or BV axis. The signed
wavevector is retained in Python/ProblemIR and metadata; negative k never
means a negative requested frequency. Both signs use identical positive
frequency windows, geometry, material, equilibrium and tolerances.
Inversion symmetry of this centred film and air domain provides a reciprocal
frequency control. An unstructured mesh may break that symmetry at finite
resolution, so compare independently certified frequencies and retain their
difference without imposing equality or fabricating the opposite-k point.
This is a separate nonzero-k control, not a substitute for Gamma, signed-path
publication, window completeness, or COMSOL A1 qualification.

### Spatial convergence controls for the expanded DE/BV range

Independent DE/BV points have certified discrete residuals below 3.41e-10,
but their difference from the uniform n=0 reference grows with k.
To test spatial discretization separately, the standalone model accepts
explicit magnetic/interface mesh levels L0 = 10 nm, L1 = 7.5 nm and
L2 = 5 nm and L3 = 3.75 nm. The material, film/cell dimensions, 2 micrometre air padding,
outer air mesh bound 100 nm, P1 tetrahedra, three requested thin-film layers,
relaxation criterion, frequency windows and physical tolerance 1e-8 remain
fixed. Mesh level and requested element size are retained in runtime metadata.
This is a magnetic/interface mesh study, not air-domain convergence.

The first comparison uses DE and BV at 25 rad/micrometre. Each solve must
still pass its original descriptor, Floquet seams, demag probes and potential
reconstruction checks; frequencies from rejected modes do not close convergence.
A higher degree count may exercise a different documented preconditioner,
which must remain explicit in provenance and cannot change the physical
operator or tolerances. These levels are inputs for a convergence experiment,
not a claim that the resulting meshes or frequencies are already converged.
Mesh construction may impose tighter local sizes; actual node/element counts
and source topology hashes must therefore also be compared.

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

| Source path | Symbol | Responsibility |
|---|---|---|
| scripts/validate_comsol_dispersion_scientific_gate.py | _canonical_path_rows | Bind caller kpath to the versioned benchmark definition by index and exact parsed vector before numeric comparisons. |
| backends/fem/tests/frequency_domain/mode_deduplication_test.cpp | void mode_deduplication_keeps_pairwise_distinct_quality_representatives | Nontransitive overlap with nonuniform positive mass, dense/CSR/legacy parity, all input permutations and original strict output; hosted execution pending. |
| backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp | void initialize_native_count_fixture | Native static H/phi owner and actual data/term digests for the physical count fixture; hosted execution pending. |
| backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp | void verify_native_count_fixture_composed_operator | Active boundary faces, canonical partitions, static/dynamic P, mass/Zeeman/gyro and demag energy-bound oracle; hosted execution pending. |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py | _sync_stage_output_snapshot | Reconcile immutable stage output families and preserve ordered autosave; selectors and StudyIR regression pending hosted CI. |
| backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp | SLEPcTinyGyrotropicModalEigenResult solve_slepc_gyrotropic_modal_eigen_attempt | Configure checked nonzero-diagonal PCLU permutation before EPS setup, preserving operator values, shift policy, original residual gate and graph quarantine; provider proof pending. |
| backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp | bool create_real_frequency_rotated_pencil | Retain exact zero structural diagonal slots in both real-split AIJ matrices for symbolic LU; preserve the operator and quarantine on hard assembly errors. Actual-provider regression pending. |
| backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp | floquet_shifted_true_convergence_test | Preserve the default convergence result and iteration budget; apply the unchanged reconstructed true-residual gate and retain scalar callback observations for a hard-error-only probe. |
| backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp | solve_slepc_sparse_gyrotropic_modal_eigen | Return the internal result carrying `FloquetShiftedKspFailureProbe`, separate from completed post-solve KSP telemetry and with the attempted EPS NEV/NCV. |
| backends/fem/cpu/frequency_domain/mode_deduplication.cpp | deduplicate_modes_by_frequency_and_overlap_with_mass_action | Strict comparison-only normalization using an explicit caller-owned geometric mass action; rejects a missing or invalid metric and retains original candidate data. |
| backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp | solve_slepc_tiny_gyrotropic_modal_eigen | Generic dense and sparse requests apply the supplied geometric mass after residual screening, then refill with fixed resolved NCV/MPD and a cumulative outer-iteration budget. |
| backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp | production_window_diagnostics_json | Serialize raw native adapter status and stop reason per subwindow, plus the explicit missing-certificate reason for strict sparse Floquet windows. |
| backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp | main | The --floquet-count-certificate entrypoint uses an expanded positive-mass fixture, proves at least four distinct modes exist before the public cap, and asserts its sole subwindow is status ok/converged before certified_count fails for the unavailable certificate. |
| crates/fullmag-runner/src/fem/eigen_native_window.rs | execute_native_cpu_modal_window_from_bloch_floquet_complex_with_provenance | Return non-OK native solve status before parsing result_json modes; strict-count error modes remain C ABI diagnostics and are not runner artifacts. |
| backends/fem/tests/frequency_domain/mode_deduplication_test.cpp | main | The test entrypoint calls `slepc_hard_solve_error_prevents_followup_queries_and_cleanup`, `slepc_vector_query_error_leaves_acquired_views_in_quarantine`, `slepc_destroy_sequence_stops_and_retains_remaining_handles_on_failure`, and `generic_candidate_span_gram_rejects_indefinite_dense_and_csr_mass`, alongside the finalizer fixture; injected callbacks verify the shared operation/destroy gates only, not PETSc runtime failures. The other cases cover phase-copy rank deficiency, mass-orthogonal modes, candidate-span PSD rejection, and missing/invalid mass. |
| backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp | main | The test entrypoint calls `generic_dense_window_refills_after_search_filtering`, covering provider-backed dense refill, partial output, nearest underfill, mass rejection, and budget telemetry; GHA execution pending. |
| backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp | std::string mode_kinematics_json_fields | Map top-level selections and all serialized modes using the request's temporal phase convention; publish its `phasor_convention` label while preserving raw eigenvalues, vectors, amplitudes, and residuals. Focused eight-case C ABI proof passed in GHA37862208552; multimode/demag/release qualification remains separate. |
| backends/fem/src/frequency_domain/modal_eigen_solver.cpp | FrequencyDomainContractResult nonzero_k_floquet_k0_poisson_path_unavailable | Preserve the requested temporal phasor label in unavailable-path diagnostics. |
| backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp | void generic_slepc_phase_convention_cabi | Exercise actual dense and CSR generic SLEPc C ABI providers for nearest and window results under both conventions; assert top-level and all-mode signed kinematics, preserve existing contour-minus coverage and request-based tiny-validation mapping, and print `PASS: modal_slepc_phase_convention_contract`. Focused GHA37862208552 passed; each case selects one physical mode and does not qualify demag or a full multimode workload. |
| backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp | SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_mass | Before overlap deduplication, form and certify only the residual-approved candidate-span Gram matrix using the declared dense or CSR mass action. |
| backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp | bool destroy_slepc_modal_objects | Stop after hard PETSc/SLEPc operation errors, check each destructor, and quarantine remaining per-call handles without further graph calls, retrying, or publishing canonical output. |
| backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp | solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context | Copy callback-owned scalar telemetry before releasing an unsafe failed EPS/KSP graph; do not query PETSc objects after a hard solve error. |
| backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp | floquet_shifted_ksp_diagnostics_json_fields | Publish `shifted_ksp_failure_probe.v1` only for a hard inner SLEPc solve failure in both nearest and window diagnostics. |
| backends/fem/tests/frequency_domain/shifted_ksp_true_convergence_test.cpp | main | Exercise callback capture and same-event threshold arithmetic, including explicit unavailable ratio at zero threshold; provider-backed execution pending. |
| backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp | main | Preserve the original near-pole case separately from refill; check attempt-scoped scalar availability and threshold arithmetic without changing solver tolerances. |
| backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp | main | Check failure-only JSON exposure on the public nearest/window paths and its absence for successful solves; provider-backed execution pending. |
| backends/fem/src/frequency_domain/mode_kinematics.cpp | frequency_hz_from_omega_rad_s | Convert the phase-signed angular frequency produced by `map_eigenvalue` to hertz; the mapper retains exact-zero default classification and explicit absolute-threshold support. |
| backends/fem/include/frequency_domain/mode_kinematics.hpp | select_positive_frequency_mode | The adjacent `ModeKinematicsPolicy` initializes `kDefaultZeroFrequencyToleranceRadPerS` to 0 rad/s; nonzero nullspace/Goldstone classification requires independent certification. |
| backends/fem/tests/frequency_domain/mode_kinematics_test.cpp | main | Test entrypoint calls `default_zero_frequency_classification_preserves_small_finite_branches`; source test only. |

Stable repository-relative `path + symbol` is the primary source identity.
The links below resolve the committed source baseline
`70636fa61fcdf32b6f61b7544f347172ef36a219`; they do not convert source
visibility into runtime qualification.

| Equation/claim | Lane | Repository path + stable symbol | Responsibility | Tests/evidence | Evidence status | Immutable link |
|---|---|---|---|---|---|---|
| Illustrative modal envelope | Shared UI source model | `apps/control-room/src/shared/analysis-charts/frequencyRenderModels.ts` + `spectralEnvelope` | Hz-consistent HWHM from artifact damping rate; unit conversion without intensity claim. | `apps/control-room/scripts/check-modal-envelope-units.mjs` | Direct production TypeScript check PASS; no browser or FEM proof | Pending scoped commit |
| Modal progress units | FEM CPU/GPU host telemetry | `crates/fullmag-runner/src/lib.rs` + `fem_eigen_progress_update` | Keep numerical residual outside physical field metrics; retain exact categorical identity. | `eigen_progress_keeps_residual_separate_from_physical_field` | Rust regression prepared, not compiled; runtime pending | [3b67a9f3c](https://github.com/MateuszZelent/fullmag/commit/3b67a9f3c6a75e0d8d5c28116170477784c3a570) |
| Modal progress display | CLI / stage resource | `crates/fullmag-cli/src/orchestrator.rs` + `format_stage_progress_line` | Show modal diagnostics without invented physical measurements or dense solver fallback. | `terminal_stage_line_includes_fem_eigen_window_progress`, `modal_solver_identity_never_infers_dense_from_missing_or_ambiguous_flags` | Rust regressions prepared, not compiled; runtime/browser pending | [3b67a9f3c](https://github.com/MateuszZelent/fullmag/commit/3b67a9f3c6a75e0d8d5c28116170477784c3a570) |
| Canonical/raw material artifacts | FEM CPU orchestration | `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` + `shared_domain_artifact_material_identity` | Shared canonical Ku signature and preserved raw plan provenance; legacy semantics retained. | `shared_domain_material_identity_preserves_raw_legacy_and_canonical_ku` | Rust regression prepared, not compiled; managed runtime pending | [799be85d3](https://github.com/MateuszZelent/fullmag/blob/799be85d3e1c40ee1d7790797d6f81536e9d9ce9/crates/fullmag-runner/src/fem/eigen_shared_domain.rs) |
| Versioned equilibrium reader | FEM CPU orchestration | `crates/fullmag-runner/src/fem/eigen_equilibrium.rs` + `load_certified_equilibrium_artifact` | Accept certified v7/v8 only and reject missing or masqueraded material identity. | `equilibrium_artifact_loader_requires_certified_v7_contract` and extended v8 cases | Source-only Rust regression; managed runtime pending | [799be85d3](https://github.com/MateuszZelent/fullmag/blob/799be85d3e1c40ee1d7790797d6f81536e9d9ce9/crates/fullmag-runner/src/fem/eigen_equilibrium.rs) |
| Zero-field stationary state | FEM CPU scope / mathematical diagnostic | `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` + `validate_shared_domain_modal_scope` | Admit zero field without asserting zero curvature or modal success; reject invalid amplitudes. | `shared_domain_modal_scope_accepts_zero_static_field`; `scripts/test_uniaxial_constrained_energy_hessian.py` + `test_zero_static_field_retains_easy_plane_and_exchange_curvature` | Rust regression prepared, not executed; independent energy test only | [ab64bac46](https://github.com/MateuszZelent/fullmag/commit/ab64bac46b7ceda295812da93244b2eba81174e4) |
| Full thickness control evidence | FEM CPU diagnostic | `scripts/collect_de_bv_thickness_comparison.py` + `collect_control` | Bind six thickness runs and Gamma before signed collection accepts convergence evidence. | `scripts/test_signed_de_bv_dispersion.py` + `test_signed_collector_requires_controller_and_separate_convergence_binding` | Synthetic contracts; not convergence qualification | Pending scoped commit |
| Signed-k solver series | FEM CPU | `scripts/run_nonzero_k_validation_controller.py` + `validation_cases` | Actual 13-point DE and BV series, plus unchanged thickness controls. | `scripts/test_signed_de_bv_dispersion.py` + `test_signed_series_has_actual_paired_samples_and_retains_convergence` | Authoring/contracts tested; runtime pending | Pending scoped commit |
| Signed-k scientific collection | FEM CPU diagnostic | `scripts/collect_signed_de_bv_dispersion.py` + `collect` | Require all actual points, bound sources, original residuals, fields, signed coordinates; measure reciprocity without imposing it. | `scripts/test_signed_de_bv_dispersion.py` + `test_signed_collector_measures_asymmetry_without_reflecting_frequencies` | Synthetic contract fixtures only; not FEM proof | Pending scoped commit |
| Kanoniczna numeracja klas periodycznych | FEM CPU preparation | `crates/fullmag-runner/src/fem/eigen_shared_domain_geometry.rs` + `modal_shared_domain_equivalence_classes` | Minimum member representative; direction/order invariant magnetic and scalar maps. | `canonical_periodic_maps_are_pair_order_and_direction_invariant`; `scripts/replay_modal_periodic_reduction_maps.py` + `replay` | Source/replay only; managed runtime required | Pending scoped commit |
| Certified static fields (source-certified-field-path-selector) | FEM CPU | `crates/fullmag-runner/src/types.rs` + `artifact_paths_for_material` | Select matching v1/v2 producer and consumer artifact paths | Source-only regressions prepared; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-bias-consumer) | FEM CPU | `crates/fullmag-runner/src/fem/eigen_execution.rs` + `execute_bias_field_sample_with_relaxation` | Consume the correct version in each independently relaxed bias-field sample | Source-only regressions prepared; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-stage-consumer) | FEM CPU | `crates/fullmag-cli/src/orchestrator.rs` + `run_script_mode` | Read material-matched field and refresh files in relax-to-eigen stage continuation | Source-only regressions prepared; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-scope-guard) | FEM CPU | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `validate_supported_relax_source` | Reject unrepresented source physics before field certificate publication | Source-only regressions prepared; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-digest) | FEM CPU | `crates/fullmag-runner/src/types.rs` + `certified_equilibrium_fields_sha256` | Bind versioned field arrays to exact little-endian binary bytes | 42 Python checks; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-copy) | FEM CPU | `backends/fem/cpu/mfem/runtime/state_io.cpp` + `int context_copy_linearization_field_f64` | Export masked dynamical fields including native uniaxial field | 42 Python checks; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-producer) | FEM CPU | `crates/fullmag-runner/src/fem/relax/finalize.rs` + `copy_native_equilibrium_evaluation` | Capture measured native fields without replacing H_eff | 42 Python checks; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-consumer) | FEM CPU | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `validate_certified_equilibrium_fields` | Validate schema, field counts, digest and native addition order | 42 Python checks; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-refresh-consumer) | FEM CPU | `crates/fullmag-runner/src/fem_eigen.rs` + `validate_recomputed_fem_linearization_certificate` | Bind v2 refresh comparison to Ku material and anisotropy evidence | 42 Python checks; native runtime pending | NOT VERIFIED | working tree |
| Certified static fields (source-certified-field-python-validation) | FEM CPU | `scripts/validate_fem_periodic_antidot_relax_eigenmodes_runtime.py` + `validate_certified_equilibrium_fields` | Independently verify schema-defined field digest and decomposition | 42 Python checks; native runtime pending | NOT VERIFIED | working tree |
| {eq}`eq-fem-modal-uniaxial-energy-hessian` (source-native-uniaxial-weak-form) | FEM CPU | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `FrequencyDomainStatus assemble_native_magnetic_a_qq` | Constrained uniaxial weak form and total-field curvature | Native regression pending; public bridge pending | source-visible / NOT VERIFIED | working tree |
| Independent constrained energy (source-uniaxial-energy-finite-difference) | reference | `scripts/test_uniaxial_constrained_energy_hessian.py` + `sphere_energy` | Energy finite differences including equilibrium-balancing bias | 3 Python tests PASS; no native execution | reference check only | working tree |
| Uniaxial descriptor transport (source-uniaxial-descriptor-builder) | FEM CPU runner | `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` + `build_native_shared_domain_modal_problem` | Own normalized axes, signed H_a and term/operator digests | Rust compilation pending; public guard retained | NOT VERIFIED | working tree |
| Uniaxial FFI ownership (source-uniaxial-ffi-envelope) | FEM CPU bridge | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `ffi_envelope_contract` | Cardinalities, advertised views and digest coherence before C ABI | Native runtime pending | NOT VERIFIED | working tree |
| Ku material identity (source-uniaxial-equilibrium-material-identity) | FEM CPU runner | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `equilibrium_material_signature` | Shared producer/consumer v2 Ku signature; exact Ku-free v1 preserved | Rust regression source; runtime pending | NOT VERIFIED | working tree |
| Ku equilibrium field owner (source-uniaxial-equilibrium-field-owner) | FEM CPU reference observer | `crates/fullmag-runner/src/fem/eigen_equilibrium.rs` + `materialize_equilibrium` | Typed anisotropy channel, separate Zeeman energy and fields | Managed runtime pending; public guards retained | NOT VERIFIED | working tree |
| {eq}`eq-fem-modal-static-field-frame-transport` (source-static-field-frame-transport) | FEM CPU | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `FrequencyDomainStatus assemble_native_magnetic_a_qq` | Cross-node static-field tangent projection | Native covariance regression prepared, not compiled | source-visible / runtime NOT VERIFIED | working tree |
| {eq}`eq-fem-k0-probe-componentwise-residual` | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `poisson_probe_componentwise_residual` | K0 probe cancellation-safe backward error | Native regression pending | source-visible / unvalidated | working tree |
| K0 probe regression | FEM CPU | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` + `main` | Invokes CertifiesChargeFreeProbeWithoutDividingByCancelledSource | Managed modal contract pending | source-visible / unvalidated | working tree |
| {eq}`eq-fem-floquet-block-residuals` | FEM CPU Floquet | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` | Evaluate `floquet_magnetic_residual` and `floquet_potential_residual` from original block actions for acceptance. | #133 candidate residuals; #136 convergence diagnostics; threshold audit | current source inspected; optimal tolerance and physics unvalidated | working-tree source hashes in `docs/audits/2026-09-25-de-residual-threshold-evidence.json`; not a published immutable source link |
| {eq}`eq-fem-floquet-full-projected-residuals` | FEM CPU Floquet | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `certify_floquet_full_descriptor` | Reconstruct the full weak equations, project into admissible test spaces, and check periodic seams and boundary-matched gauge policy. | Source review; managed build and pilot pending | source-visible; runtime certification NOT VERIFIED | repository working tree |
| {eq}`eq-fem-floquet-full-projected-residuals` | FEM CPU runner | `crates/fullmag-runner/src/fem/eigen_native_result.rs` + `native_floquet_physical_mode_certificate_from_json` | Validate physical complex-coefficient certificate flags, residuals, and boundary/gauge provenance; preserve the inapplicable gauge residual as null. | Source review; Rust compilation pending managed build | source-visible; runtime propagation NOT VERIFIED | repository working tree |
| {eq}`eq-fem-floquet-full-projected-residuals` | FEM CPU runner | `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` + `floquet_certificate_summary` | Publish the physical Floquet certificate summary without promoting an uncertified mode; keep the legacy doubled-real payload contract separate. | Source review; artifact validation pending managed execution | source-visible; runtime artifacts NOT VERIFIED | repository working tree |
| Nearest-frequency nonzero-k Floquet selected diagnostic | FEM CPU | `crates/fullmag-runner/src/fem/eigen_capability.rs` + `native_cpu_modal_window_has_floquet_dynamic_demag_path`; `crates/fullmag-runner/src/fem/eigen_execution.rs` + `execute_fem_eigen_inner` | Route a bounded `target="nearest"` request through the existing Floquet/dynamic-demag Schur operator while retaining one global target per path, original residual gates and selected-only completeness. | `scripts/test_nearest_floquet_dynamic_demag_routing_source.py`; prepared Rust regressions `planned_floquet_dynamic_demag_nearest_target_dispatches_same_cpu_engine` and `native_cpu_modal_window_accepts_nonzero_floquet_airbox_demag_nearest_target` | Source/interpreted checks PASS; native compilation, managed runtime and physics qualification pending | working tree |
| Nearest-frequency Floquet resolution | FEM CPU runner | `crates/fullmag-runner/src/fem/eigen_execution_resolution.rs` + `resolve_fem_eigen_execution_resolution` | Keep the exact Floquet CPU engine and double-precision contract for nearest single-k and constant-target multi-k paths. | `planned_floquet_dynamic_demag_nearest_target_dispatches_same_cpu_engine` | Source/interpreted checks PASS; native compilation and managed runtime pending | working tree |
| source-nearest-floquet-native-producer-metadata | FEM CPU native producer | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` + `solve_sparse_production_modal_payload` | Publish actual nearest target metadata and selected-only/window-incomplete semantics in both native diagnostics and result envelopes; leave frequency-window completeness separate. | `scripts/test_nearest_floquet_dynamic_demag_routing_source.py` | Source/interpreted checks PASS; native compilation, managed runtime and physics qualification pending | working tree |
| Nearest-frequency routing source regression | Source verification | `scripts/test_nearest_floquet_dynamic_demag_routing_source.py` + `test_native_solver_keeps_residual_and_selected_only_policies` | Freeze public target transfer, original residual policies and selected-only/window-complete separation without claiming native execution. | Script PASS | Interpreted source check only; native compilation, managed runtime and physics qualification pending | working tree |
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
| {eq}`eq-fem-dynamic-floquet-constraint` validation | FEM response | `backends/fem/src/frequency_domain/driven_response_solver.cpp` + `validate_driven_response_floquet_phase_constraints` | Validate phase cycles, tangent-frame equality and drive consistency. | focused Floquet response tests | source tested; demag-k bridge source-visible, managed/physics unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/backends/fem/src/frequency_domain/driven_response_solver.cpp) |
| {eq}`eq-fem-modal-tangent-frame-rotation` | FEM CPU modal | `backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp` + `build_tangent_constraint_entries` | Apply `T_member^T T_rep` and Floquet phase for local tangent-coordinate transport; fail closed on invalid frames or a different equilibrium. | regression authored for rotated basis and mismatch rejection; not compiled | source visible; runtime unvalidated | repository source |
| Contract text regression | documentation | `scripts/test_frequency_domain_math_contract_docs.py` + `test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims` | Freeze canonical algebra, units, lane names and claim status. | same symbol | source tested; not numerical evidence | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/scripts/test_frequency_domain_math_contract_docs.py) |
| {eq}`eq-fem-full-bloch-ansatz`, {eq}`eq-fem-full-bloch-demag`, {eq}`eq-fem-full-bloch-weak` | FEM CPU/GPU planned | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` + `DOC-ANCHOR:full-bloch-operator-contract` | Freeze the 3D full Bloch field, ordinary-gradient demagnetization and weak-form boundary before production assembly. | S03/S04 and V0/V4 are pending | planned contract; no runtime evidence | repository note |
| {eq}`eq-fem-waveguide-envelope-demag` | FEM CPU/GPU planned | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` + `DOC-ANCHOR:waveguide-envelope-operator-contract` | Freeze the separate 2.5D waveguide envelope and shifted-gradient demagnetization equations. | S09/V5 pending | planned contract; no runtime evidence | repository note |
| Full Bloch tangent prolongation | FEM CPU planned | `backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp` + `class FloquetTangentProlongation` | Represent phase and tangent-frame transport for the interleaved local coefficients. | `fem_floquet_magnetic_operator_contract` source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated; not connected to solver ABI | repository source |
| Reduced full Bloch operator | FEM CPU planned | `backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp` + `class FloquetReducedMagneticOperator` | Define the matrix-free $C(\mathbf k)^\mathsf{H}AC(\mathbf k)$ boundary. | same focused contract test; no managed FEM run | source visible; uncompiled/unvalidated; not connected to solver ABI | repository source |
| Dynamic nonzero-k demagnetization oracle | FEM CPU source-visible | `backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp` + `build_floquet_dynamic_demag_k_real_split` | Provide the bounded dense Schur oracle for complex nonzero-k dynamic demagnetization; mesh assembly and production qualification remain separate. | `fem_floquet_dynamic_demag_k_contract` source is present; managed compile/runtime unvalidated | source visible; managed/physics unvalidated | repository source |
| MFEM Floquet airbox bridge | FEM CPU planned | `backends/fem/cpu/frequency_domain/floquet_airbox_operator.hpp` + `assemble_floquet_airbox_dynamic_demag_k` | Materialize bounded `C(k)^H P_full(k) C(k)` and `C(k)^H A_{phi q}` blocks, then delegate Schur elimination to the dynamic demag-k provider; production mesh assembly and capability promotion remain separate. | `fem_floquet_airbox_operator_contract` source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated | repository source |
| Waveguide nonzero-k demagnetization oracle | FEM CPU planned | `backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp` + `build_floquet_waveguide_demag_k_real_split` | Provide the bounded 2.5D modified-Helmholtz and Schur oracle; transverse MFEM assembly and open-boundary convergence remain separate. | `fem_floquet_waveguide_demag_k_contract` source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated | repository source |
| Existing shared-domain Poisson owner | FEM CPU | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` + `assemble_poisson_airbox_shared_domain` | Preserve the existing K0/shared-domain assembly boundary while nonzero-k demag remains gated. | existing source contract tests | source visible; nonzero-k physics unvalidated | repository source |
| Floquet pure-Neumann invertibility policy | FEM CPU | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `assemble_poisson_airbox_shared_domain_payload` | For Floquet k, clear the k=0 gauge and defer scalar solvability to the phase-constrained operator factorization and residual checks; do not use a universal $|k|L$ cutoff. | source review; managed nonzero-k physics still unvalidated | source visible; nonzero-k physics unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/7a8b57cf1ca6b64902cdee60945cebdda9e2bd4c/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp) |
| Cached K0 window preconditioning | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` + `bool create_production_cached_window_preconditioner` | Retain demag in bounded cached preconditioning across shifts. | Managed runtime pending | source-visible / unvalidated | working tree |
| Bounded K0 Krylov selected spectrum | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` + `bounded_krylov_dimensions` | Keep standalone positive nearest 2x and borrowed window 4x; bounded explicit ncv and diagnostic evidence. | Native regression prepared; printf arity 27 calls checked | source-visible / unvalidated | working tree |
| K0 diagnostic variadic safety | Source verification | `scripts/check_fem_schur_printf_contract.py` + `check_source` | Match literal printf placeholders with variadic arguments; reject missing ncv. | 27 literal calls plus 5 regression checks PASS | source verification only | working tree |
| Bounded K0 window ncv regression | FEM CPU test source | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` + `void FrequencyWindowDoesNotRetryWhenOnlyTheGlobalRequestIsSaturated` | Verify bounded base/refined ncv and every subwindow's actual published request. | Native unit compilation prohibited; prepared only | NOT VERIFIED | working tree |
| Failed EPS diagnostic regression | FEM CPU test source | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` + `void PreservesFailedSchurEpsCountersWithoutPublishingModes` | Preserve performed work without publishing stale or partial modes. | Native unit compilation prohibited; prepared only | NOT VERIFIED | working tree |
| R4 exact identity preimages | FEM Rust source | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `signature_digest_and_preimage` | Preserve namespace/byte-length/exact JSON replay with legacy and canonical Ku identities. | Parser PASS; native regressions prepared | Complete R4/runtime NOT VERIFIED | working tree |
| R4 all-family replay regression | FEM Rust test source | `crates/fullmag-runner/src/fem/eigen_tests.rs` + `equilibrium_and_modal_preimages_replay_all_identity_families` | Independent byte replay and mutation checks for all five identities. | Parser PASS; prepared only | Native execution NOT VERIFIED | working tree |
| source-r4-remap-single-k-mode-artifacts | FEM Rust source | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` + `remap_single_k_mode_artifacts` | Signed sample evidence without payload mutation or field-selection loss. | Parser PASS; native regression prepared | Runtime NOT VERIFIED | working tree |
| source-r4-retain-selected-eigen-path-mode-artifacts | FEM Rust source | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` + `retain_selected_eigen_path_mode_artifacts` | Signed sample evidence without payload mutation or field-selection loss. | Parser PASS; native regression prepared | Runtime NOT VERIFIED | working tree |
| source-r4-signed-sidecars-preserve-exact-bytes-across-samples | FEM Rust source | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` + `signed_sidecars_preserve_exact_bytes_across_samples` | Signed sample evidence without payload mutation or field-selection loss. | Parser PASS; native regression prepared | Runtime NOT VERIFIED | working tree |
| source-r4-build-eigen-path-frequency-domain-manifest | FEM Rust source | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` + `build_eigen_path_frequency_domain_manifest` | Signed sample evidence without payload mutation or field-selection loss. | Parser PASS; native regression prepared | Runtime NOT VERIFIED | working tree |
| Coupled cached-window regression | FEM CPU | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` + `void FrequencyWindowRetainsDemagInBoundedCachedPreconditioner` | Known Schur frequency across shifts and fresh windows. | Native compilation prohibited; pending | source-visible / unvalidated | working tree |

### Anulowanie podczas materializacji preconditionera K0

Jeśli przerwanie zostanie zaobserwowane podczas budowania dokładnego
preconditionera Schura, solver zwraca `interrupted` z `cancel_requested`.
Nie przechodzi do zastępczego preconditionera magnetycznego i nie klasyfikuje
anulowania jako awarii operatora. Nie zmienia to operatora eigenproblemu,
równań fizycznych ani progów residualu. Regresja native wymaga managed
kompilacji i uruchomienia; stan tej nowej ścieżki pozostaje NOT VERIFIED.

Materializacja sprawdza callback anulowania przed każdą kolumną, niezależnie
od tego, czy bezpośredni solve Poissona wywołuje callback iteracyjny KSP.

| Source ID | Plik | Symbol | Odpowiedzialność |
|---|---|---|---|
| `source-k0-cached-window-cancellation-regression` | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` | `void FrequencyWindowCancellationDuringCachedPreconditionerPreservesStopReason` | Anulowanie podczas materializacji cache przed EPS; native runtime NOT VERIFIED. |

### Tożsamość modu podczas agregacji multi-k

Przejście z single-k do multi-k wymaga jawnego indeksu modu mieszczącego
się w typie hosta i jawnej skończonej częstotliwości w Hz. Powtórzone
indeksy w jednym punkcie są błędem. Brak indeksu ani częstotliwości nie
może tworzyć fikcyjnego modu 0 lub punktu 0 Hz. Jawne 0 Hz pozostaje
legalne; walidacja tożsamości nie stanowi dowodu fizycznego trybu zerowego.
Niezmieniony certyfikat native pozostaje związany z punktem, indeksem i
częstotliwością. Nowa regresja Rust wymaga kompilacji: NOT VERIFIED.

| Source ID | Plik | Symbol | Odpowiedzialność |
|---|---|---|---|
| `source-multi-k-native-mode-identity` | `crates/fullmag-runner/src/fem/eigen_path.rs` | `eigen_path_native_mode_identities` | Jawne indeksy i częstotliwości przed trackingiem; brak domyślnego modu 0. |
| `source-multi-k-native-mode-identity-regression` | `crates/fullmag-runner/src/fem/eigen_path.rs` | `native_mode_identity_rejects_missing_fields_and_duplicates` | Brak/błędny typ/powtórzony indeks; legalne jawne zero i zachowanie kolejności. Rust runtime NOT VERIFIED. |


## Diagnostyka consistent-mass zapisanych modów DE/BV

<!-- DOC-ANCHOR:de-bv-consistent-mass-profile -->

Ta diagnostyka offline nie zmienia solvera, Python DSL ani ProblemIR.
Dotyczy wyłącznie zaakceptowanych modów FEM CPU, P1 tet4, jednego filmu
z jednorodnym materiałem i konwencją przestrzenną exp_minus_i_k_dot_delta_r.
FEM GPU i FDM CPU/GPU nie są przez ten skrypt walidowane.
Przed użyciem pola odtwarza się pakowanie filmu/powietrza z
`crates/fullmag-plan/src/mesh.rs` + `pack_mesh_by_analysis` i wymaga
bitowo zgodnego fingerprintu v3 końcowej topologii oraz hashy payloadów.
Nie wystarcza zgodna liczba węzłów. Inne markery lub topologie są odrzucane.

```{math}
:label: eq-de-bv-profile-consistent-mass
u_i=\exp(+\mathrm{i}\mathbf{k}\cdot\mathbf{r}_i)m_i,\qquad
(M_T)_{ab}=\frac{V_T}{20}(1+\delta_{ab}),\qquad
\langle u,v\rangle_M=\sum_T\sum_{a,b=1}^4 (M_T)_{ab}u_a^\mathsf{H}v_b.
```

```{math}
:label: eq-de-bv-profile-overlap
C(u,v)=\frac{|\langle u,v\rangle_M|^2}
{\langle u,u\rangle_M\langle v,v\rangle_M}.
```

| Token | Znaczenie | Jednostka SI |
|---|---|---|
| $u_i,v_i,m_i$ | Zespolone wektory węzłowe; $m_i$ jest polem Blocha, $u_i,v_i$ jego odfazowanymi profilami. Normalizacja amplitudy jest dowolna i znosi się w $C$. | $1$ |
| $\mathbf{k}$ | Wektor falowy. | $\mathrm{rad\,m^{-1}}$ |
| $\mathbf{r}_i$ | Pozycja węzła w końcowej kolejności solvera. | $\mathrm{m}$ |
| $T,a,b,V_T$ | Tetraedr magnetyczny, lokalne indeksy węzłów i jego dodatnia objętość. | $1,1,1,\mathrm{m^3}$ |
| $M_T$ | Dokładna lokalna macierz masy liniowego tetraedru dla iloczynu wektorów. | $\mathrm{m^3}$ |
| $\delta_{ab},\mathrm{i},C$ | Delta Kroneckera, jednostka urojona i kwadrat znormalizowanego nakładania. | $1$ |
| $\langle u,v\rangle_M$ | Iloczyn skalarny FE ograniczony do filmu magnetycznego. | $\mathrm{m^3}$ |

Macierz masy jest consistent, nie lumped. Jednorodny czynnik materiałowy
znosi się w normalizacji; materiał niejednorodny wymaga odrębnej metryki.
Odfazowanie wartości węzłowych i ich interpolacja P1 jest diagnostycznym
przybliżeniem profilu ciągłego, nie dokładnym mnożeniem funkcji FE przez
wykładniczą funkcję w całym tetraedrze. Wynik jest niezmienniczy na globalną
fazę i skalę. Porównujemy sąsiednie zapisane mody i projekcję na stały wektor.
Wysokie $C$ wspiera ciągłość profilu, ale nie dowodzi najniższej gałęzi,
kompletności widma, braku degeneracji ani zbieżności siatki/airboxu.

Źródła implementacji: `scripts/compare_de_bv_mode_profiles.py` +
`pack_single_film_mesh`, `consistent_inner_product`, `normalized_overlap`.
Regresje: `scripts/test_compare_de_bv_mode_profiles.py`.
To zapisany postprocessing zaakceptowanych historycznych runów, nie wykonanie
nowego native runtime i nie kwalifikacja A1/COMSOL ani GPU.


| Id | Źródło | Symbol | Odpowiedzialność |
|---|---|---|---|
| `source-profile-packing` | `scripts/compare_de_bv_mode_profiles.py` | `pack_single_film_mesh` | Recover single-film final ordered topology before comparing fields |
| `source-profile-mass` | `scripts/compare_de_bv_mode_profiles.py` | `consistent_inner_product` | Exact consistent P1 tetrahedral mass inner product |
| `source-profile-overlap` | `scripts/compare_de_bv_mode_profiles.py` | `normalized_overlap` | Phase- and scale-invariant squared overlap |
| `source-profile-mass-regression` | `scripts/test_compare_de_bv_mode_profiles.py` | `test_exact_p1_basis_mass_differs_from_lumping` | Independent analytical P1 basis mass check distinguishes consistent from lumped mass |


## Zagęszczona ścieżka walidacyjna DE/BV

Wejście examples/fem_de_smoke_numeric.py obsługuje teraz żądanie
FULLMAG_DE_SMOKE_SAMPLING=positive-26 lub bv-positive-26: 26 punktów
od 0 do 25 rad/µm co 1, odpowiednio k prostopadłe/równoległe do M0=x.
To rozszerzenie istniejącego fixture, bez nowego publicznego API ani pól IR.
KPath zawiera 26 jawnych KPoint i 25 odcinków samples_per_segment=1,
a count=1 żąda jednego fizycznego modu na próbkę. Wszystkie próbki danego
study korzystają z jednego źródłowego etapu relaksacji i jednej siatki.
Adapter punktu Gamma normalizuje zerowy wektor z Floquet do Periodic;
samodzielne k0 i bv-k0 od razu autorują PeriodicBC/periodic_airbox_k0.
Źródło normalizacji: crates/fullmag-runner/src/fem/eigen_path_guards.rs,
normalize_gamma_floquet_point_to_periodic_k0. Jej aktualny runtime wymaga buildu.

Każdy punkt ma także samodzielne wejście kN lub bv-kN, N od 0 do 25,
aby diagnozować konkretny brak. Takie osobne runy nie dowodzą wspólnego
accepted equilibrium ani produkcyjnego trackingu całej ścieżki.
Materiał, geometria, demag, PBC i SI pozostają takie jak w frozen film fixture:
40×40×10 nm, Ms=800 kA/m, A=13 pJ/m, B=0.1 T w osi x, airbox po 2 µm.

Nowy walidator gęstej ścieżki wymaga wszystkich 26 próbek, operator probe
Gamma i operator probes dla 25 niezerowych punktów oraz pełnego certyfikatu
descriptora każdego modu. Certyfikat tylko zredukowanych bloków nie wystarcza.
Okno DE wynosi 8.5–16 GHz, BV 8.5–12 GHz; fizyczny próg residualu 1e-8
pozostaje bez zmian. Te żądania nie dowodzą kompletności widma ani gałęzi.

Regresje eksportu IR i syntetycznych artefaktów nie są numerycznym FEM runem.
FEM CPU: source/contract evidence; aktualny managed runtime NOT VERIFIED.
FEM GPU i FDM CPU/GPU: ten fixture ich nie waliduje. Biblioteka musi mieć
zgodny native source binding i legalny profil runnera przed właściwym solve.

Kontrola gęstej ścieżki porównuje również cały inventory spectrum.v3 z
żądaniem: dokładnie 26 unikalnych próbek i jeden zaakceptowany mod na każdą,
a sample_count musi zgadzać się z listą. Gamma wymaga native_descriptor;
każdy niezerowy punkt wymaga full_projected_weak_form_and_periodic_seams.
Sama flaga full_descriptor_certified nie identyfikuje właściwego operatora.
Niezerowe punkty tego fixture wymagają poisson_boundary_kind=poisson_dirichlet
oraz poisson_gauge_policy=none, zgodnie z zadanymi granicami airboxu.
Efektywna tolerancja gęstej ścieżki jest minimum rtol żądania, tolerancji
certyfikatu oraz zamrożonego progu 1e-8. Opcje diagnostyczne nie mogą
poluzować tej bramki. Nie jest to dowód zbieżności dyskretyzacji.
Źródła: scripts/validate_de_smoke_rows.py + load_spectrum_v3_modes oraz
validate_rows; regresja: scripts/test_de_smoke_dense_sampling.py +
test_dense_certificate_inventory_and_scope_are_strict.

## Indeks źródeł zagęszczonej ścieżki

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| `source-dense-spectrum-inventory` | `scripts/validate_de_smoke_rows.py` | `load_spectrum_v3_modes` | Strict relative and block certificates and unique sample inventory |
| `source-dense-row-preflight` | `scripts/validate_de_smoke_rows.py` | `validate_rows` | Dense path completeness, Gamma/nonzero operator scope and frozen residual admission |
| `source-dense-contract-regression` | `scripts/test_de_smoke_dense_sampling.py` | `test_dense_certificate_inventory_and_scope_are_strict` | Reject loose or misplaced certificates and extra spectrum records |
| `source-dense-input-regression` | `scripts/test_de_smoke_dense_sampling.py` | `test_dense_path_has_26_samples_and_one_shared_relaxation` | Public DE/BV KPath export and one shared source relaxation |


## Przygotowanie wektora produkcyjnego trackingu — kontrola payloadu i fazy

Dla ścieżki Floqueta przestrzenny mod delta_m zawiera exp(-i k·r).
Tracker ma porównywać nodalny envelope exp(+i k·r) delta_m, w globalnym
układzie Cartesian XYZ, zgodnie z wcześniej zdefiniowanym porównaniem profili.
Zmiana fazy jest postprocessingiem trackingu; publikowane pola, równania
solvera i temporalny phasor exp(+i omega t) pozostają oddzielnymi kontraktami.
Dla Gamma i niefloquetowych granic nie usuwa się przestrzennej fazy.

Adapter wymaga pełnego indeksowania siatki dla obu tablic real/imag,
dokładnie trzech skończonych komponentów na węzeł oraz zgodnego surowego
ID modu i wektora k. Nie usuwa wadliwego wiersza ani nie zastępuje brakującego
komponentu zerem. Wybrane aktywne węzły muszą być unikalne i w zakresie.
Duplikat artefaktu, uszkodzony JSON lub obecne lecz wadliwe pole są błędem runu.
Brak artefaktu lub obu pól pozostawia jawnie niedostępny modal overlap;
obsługa frequency fallback nadal nie jest dowodem ciągłości fizycznej gałęzi.

Źródła: crates/fullmag-runner/src/fem/eigen_path_artifacts.rs +
eigen_path_mode_tracking_vector i crates/fullmag-runner/src/fem/eigen_output.rs +
mode_vector_entries. Realizacja jest przygotowaniem źródeł FEM CPU/GPU
postprocessingu na CPU; kompilacja i managed runtime tych zmian NOT VERIFIED.
FDM CPU/GPU nie są realizowane przez ten adapter.

Poprawka payload/fazy opisana w tej sekcji sama nie zmienia diagonalnego/lumped
iloczynu skalarnego. Oddzielny przyrost consistent P1 opisano poniżej.
S06 wymaga nadal metryki consistent P1, kontroli tożsamości mesh/equilibrium,
transportu podprzestrzeni oraz runtime na pełnej ścieżce. Offline consistent-mass
profile pozostają diagnostyką, nie produkcyjnym zaliczeniem tej bramki.


## Indeks źródeł przygotowania envelope

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| `source-tracking-envelope-payload` | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `eigen_path_mode_tracking_vector` | Strict full-node Cartesian payload binding and spatial Bloch envelope preparation |
| `source-tracking-cartesian-parser` | `crates/fullmag-runner/src/fem/eigen_output.rs` | `mode_vector_entries` | Shared finite XYZ parser preserving exact node indices |
| `source-tracking-envelope-regression` | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `tracking_unwinds_spatial_bloch_phase_in_selected_node_order` | Uncompiled regression for periodic-envelope reconstruction and node order |


## Produkcyjna realizacja consistent P1 mass dla trackingu (źródła WIP)

Docelowy iloczyn skalarnego i norma są te same co w
`eq-de-bv-profile-consistent-mass`, ale overlap produkcyjny jest modułem
znormalizowanego iloczynu, a diagnostyka offline zapisuje jego kwadrat.
Implementacja ma zachować wszystkie fizyczne węzły magnetyczne, również
slave nodes na periodycznych granicach; nie zastępuje consistent mass sumą
wag klas Floqueta. Wektory pozostają globalnymi XYZ nodalnymi envelope.

Realizacja używa liniowego embeddingu lokalnego na tetraedrze: cztery
wektory węzłowe oraz ich suma, każdy przemnożony przez pierwiastek lokalnej
wagi consistent mass. Wspólne skalowanie przez największą objętość
stabilizuje obliczenie i kasuje się w znormalizowanych overlapach.
Iloczyn euklidesowy embeddingów odtwarza dokładnie consistent P1 mass
z dokładnością do tego wspólnego skalowania; nie buduje gęstej macierzy.
Transport zdegenerowanych podprzestrzeni ortonormalizuje embeddingi,
wykonuje dotychczasowe SVD/Procrustes i odzyskuje nodalne envelope.

Metryka wiąże się z tożsamością pełnej uporządkowanej siatki, kolejnością
węzłów magnetycznych, tetraedrami i objętościami. Niezgodność lub metryka
obecna tylko po jednej stronie zabrania fallbacku euklidesowego. Ścieżki
legacy bez tego kontekstu zachowują swoje jawnie odróżnione stare metryki.
Pełna identity equilibrium pozostaje osobną wymaganą kontrolą S06.

Kod: crates/fullmag-runner/src/eigen/tracking_mass.rs + ConsistentP1TrackingMetric;
integracja: tracking.rs + modal_overlap_views oraz tracking_subspace.rs +
mass_weighted_subspace_transport i fem/eigen_path.rs. Rust/backend runtime
NOT VERIFIED; FEM CPU/GPU używają postprocessingu CPU, bez dowodu GPU parity.
FDM CPU/GPU nie korzystają z tego adaptera. Nie zmienia się publicznego Python
ani IR, liczby modów, residualu, fizycznych pól i wyników solvera.

Metryka jest współdzielona przez Arc w całej ścieżce; adapter nie kopiuje
siatki do każdego modu ani punktu. Zmiana tożsamości siatki pomiędzy próbkami
zatrzymuje tracking. Ocena jednorodnego modu Gamma używa projekcji na
przestrzennie stały wektor w tej samej consistent mass, bez fallbacku nodalnego.
Do diagnostyki trafia definition_id oraz source_mesh_topology_sha256;
persisted reconstruction kontekstu metryki i niezależna pełna identity
równowagi pozostają wymaganiami przed zaliczeniem S06/S07.

## Indeks źródeł produkcyjnej metryki consistent mass

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| `source-tracking-consistent-metric` | `crates/fullmag-runner/src/eigen/tracking_mass.rs` | `ConsistentP1TrackingMetric` | Exact consistent tet4 Cartesian embedding and nodal recovery |
| `source-tracking-consistent-pair` | `crates/fullmag-runner/src/eigen/tracking.rs` | `modal_overlap_views` | Use the bound exact metric before pair assignment without mixed-metric fallback |
| `source-tracking-consistent-subspace` | `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | `mass_weighted_subspace_transport` | Consistent-mass orthonormalization, principal angles and recovered branch frames |
| `source-tracking-consistent-fem-adapter` | `crates/fullmag-runner/src/fem/eigen_path.rs` | `eigen_path_consistent_tracking_metric` | Construct a shared exact metric on every physical magnetic node |
| `source-tracking-consistent-basis-regression` | `crates/fullmag-runner/src/eigen/tracking.rs` | `exact_consistent_tracking_overlap_includes_offdiagonal_p1_mass` | Uncompiled analytic regression distinguishes consistent and diagonal mass |

### Natywny Floquet tangent-mass assembly foundation

Niezależnie od metryki używanej przez postprocessing trackingu, natywne
assembly FEM CPU dla niezerowego $\mathbf k$ przechowuje teraz geometryczną,
consistent masę P1 w pełnej lokalnej bazie stycznej. Wkład każdego aktywnego
elementu magnetycznego używa fizycznych węzłów i iloczynów wektorów ram
stycznych; periodyczne kopie pozostają w pełnej macierzy. Wewnętrzny
Floquet tangent constraint redukuje macierz do zespolonego CSR przez
$C_q(\mathbf k)^\mathsf H M_\mathrm{tan,full} C_q(\mathbf k)$. Metryka nie
jest blokiem żyromagnetycznym $B_{qq}$ i nie ma wag $M_s$ ani $\gamma_0$.

Ten przyrost dodaje właściciela full/reduced CSR i przekazuje wskaźnik do
wewnętrznego DTO operatora. W jednym wywołaniu native Floquet solver
`solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` używa
reduced CSR wyłącznie do deduplikacji kandydatów, którzy przeszli istniejącą
bramkę original-block residual. Aplikacja metryki jest callbackiem na owned
complex CSR; nie materializuje macierzy dense i nie używa gyrotropic `B_qq`.
Normalizowane kopie służą tylko porównaniu overlap; zaakceptowany mod jest odtwarzany z
`source_index`, aby zachować oryginalną amplitudę $q$, potencjał, residual i
identyfikator pary własnej. Wewnętrzny `detail::finalize_certified_floquet_candidates`
wykonuje deduplikację, sortowanie względem żądanej częstotliwości i lokalny
limit liczby modów. Używa względnej tolerancji częstotliwości $10^{-8}$ ($1$),
absolutnej tolerancji $10^{-12}\,\mathrm{Hz}$ i progu mass-overlap $0.90$ ($1$).

Deduplikacja całej puli kandydatów z sąsiednich subwindow w native Floquet
również używa tego samego finalizatora i owned reduced CSR mass. Na tym etapie
odległości celu są zerowe, a lokalny limit jest równy rozmiarowi wejściowej puli:
żaden unikalny kandydat nie jest usuwany przed istniejącym window sortowaniem
według częstotliwości i końcowym limitem użytkownika. Błąd metryki propaguje się
jako hard solve failure; wcześniejsza przyczyna hard subwindow failure pozostaje
zachowana. Native merge nie materializuje dense mass ani nie stosuje identity
fallbacku. Generic sparse/dense adapter pozostaje osobnym etapem i nadal wymaga
korekty.

### Bounded NEV refill w native Floquet

Natywny solver wykonuje mass-deduplication i nearest cap na certyfikowanych
kandydatach przed zamknięciem bieżącego EPS. Jeżeli liczba unikalnych modów jest
mniejsza od żądanej, tworzy kolejną próbę Krylov–Schur ze ściśle większym NEV.
Początkowe NCV i MPD pozostają niezmienione; retry zatrzymuje się na legalnym
limicie NEV wyznaczonym przez początkowe NCV i wymiar real-split. Żadna próba nie
łączy indeksów ani niecertyfikowanych kandydatów z poprzednim EPS: wynikowa pula
zawiera wyłącznie finalizację ostatniej bezpiecznie rozwiązanej próby.

Pierwsze EPSSetUp rozstrzyga całkowity budżet max_outer_iterations.
Każde kolejne EPSSolve otrzymuje wyłącznie pozostałe iteracje, a wynik sumuje
faktycznie zaraportowane iteracje wszystkich prób. Budżet iteracji liniowych KSP
pozostaje niezmieniony dla każdej próby. Osiągnięcie limitu wymiaru lub iteracji
zwraca subwindow status partial i tylko certyfikowane mody. Wewnętrzny guard NEV jest
nadmiarem kandydatów na subwindow, a nie minimalną liczbą modów obiecaną przez
publiczny parametr count. Dla polityki best_effort ograniczenie wymiaru może
zakończyć solve statusem ok, jeśli po filtracji pasma i deduplikacji metryką
pozostaje co najmniej jeden certyfikowany mod. Taki wynik zachowuje
window_completeness.status=partial_convergence, complete=false i informację o
wewnętrznej przyczynie; nie certyfikuje ani nie wyczerpuje pasma, a liczba
zwróconych modów może być mniejsza od publicznego limitu. Jeśli pula przekracza
limit publikacji, istniejąca klasyfikacja truncated_by_requested_count pozostaje
właściwa. Status ok oznacza dostępny wynik runtime; nie zastępuje odrębnej
kwalifikacji naukowej 8-band. Pusta pula, wyczerpanie budżetu EPS, anulowanie
lub błąd solvera oraz polityka certified_count pozostają fail-closed. Dla
natywnego sparse Floquet powód jest konkretny: bounded shift-invert EPS pools
dostarczają residual-screened kandydatów, ale nie certyfikat liczby modów dla
całego okna. Partition raportuje `certification_method=none`; jedyny obecny
producer `count_certificate` należy do osobnego solvera contour-interval.
Wynik `certified_count` z tego Floquet adaptera musi więc zakończyć się
`solve_error` z `native_floquet_count_certificate_unavailable`, również gdy
shift-y się zbiegły. C ABI może zachować już zwalidowane mody w polu
`modes` odpowiedzi błędu wyłącznie jako diagnostykę; status nie oznacza
udanego strict-policy. Runner Rust
`execute_native_cpu_modal_window_from_bloch_floquet_complex_with_provenance`
zwraca błąd przed parsowaniem `result_json.modes`, gdy status native nie jest
`Ok`, więc ta ścieżka nie publikuje tych modów do artefaktu. Diagnostyka utrzymuje
`additional_modes_may_exist=true` i brak certyfikacji; solverowy błąd albo
częściowa zbieżność zachowują własną klasyfikację. Polityka `best_effort`
może nadal zwrócić niepustą, residual- i mass-screened pulę z
`complete=false`; nie oznacza to certyfikacji pokrycia ani liczby modów.
Anulowanie jest sprawdzane przed
próbą, przez standardowe EPSStoppingBasic z EPS_CONVERGED_USER oraz przed
następnym retry; wynik ma status interrupted, nie zbieżność.

Jest to wewnętrzna polityka solvera. Nie zmienia równań, residuów, SI, publicznego
Python/ProblemIR, liczby żądanych modów ani wejściowego limitu pamięci. Źródło i
regresja produkcyjnego SLEPc są widoczne; provider-backed GHA regresja jest
jeszcze **NOT VERIFIED**. Sam test finalizatora nadal nie dowodzi refill ani
kwalifikacji fizycznej.

Regresja assembly porównuje full i reduced CSR z niezależną analityczną masą
tet4 / prism6 oraz ręcznie zbudowanym ograniczeniem fazy i ram stycznych.
Deterministyczna regresja finalizatora przekazuje jawny zestaw już
residual-certified kandydatów bezpośrednio do tej samej funkcji, którą wywołuje
solver; sprawdza duplikat, odrębny mass-orthogonal mode i cap po deduplikacji.
Omija EPS celowo, więc nie dowodzi, że SLEPc dostarczy te kandydaty, ani nie
weryfikuje ich certyfikacji lub refill/NEV. Finalizator i ta regresja zostały
skompilowane oraz uruchomione w no-provider GHA run `37795426460`, job
`113373527111`, na commicie `082295567367c31d81b26e1904a8a627dc1d24cf`: CTest
3/3 PASS, w tym `fem_floquet_modal_solver_contract`. Assembly MFEM i EPS nie są
dowodzone przez ten run; managed runtime, rzeczywiste wykorzystanie metryki
w EPS i naukowa kwalifikacja pozostają **NOT VERIFIED**.

Provider assembly proof: GHA `37797035215`, job `113379085747`, source
`e570d4c957674724be7cb7990ca0de25aee1c156` wykonał MFEM CPU v4.10 oracle oraz
cały `fem_poisson_airbox_shared_domain_contract`: 1/1 PASS. Receipt wymagał
`FULLMAG_HAS_MFEM_STACK=1`, observed assertion marker, zgodnego SHA i owner
finish. To dowód assembly/phase-reduction, nie wykonania EPS, convergence ani
produkcji całej dyspersji.

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| `source-floquet-tangent-mass-assembly` | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` | `assemble_poisson_airbox_shared_domain` | Unique declared entrypoint; its implementation forms full geometric P1 tangent mass on physical magnetic nodes and phase-reduced complex CSR |
| `source-floquet-tangent-mass-regression` | `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp` | `main` | Unique test entrypoint calls `floquet_positive_tangent_mass_matches_independent_phase_reduction`; independent tet4/prism6 mass and $C_q^\mathsf H M C_q$ oracle with phase copies and nonuniform tangent frames; MFEM CPU GHA 37797035215 passed |
| `source-floquet-tangent-mass-overlap-owner` | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `detail::finalize_certified_floquet_candidates` | Apply the positive reduced CSR mass action to already residual-certified candidates, retain original modes by source index, then target-rank and cap |
| `source-floquet-tangent-mass-overlap-seam` | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.hpp` | `finalize_certified_floquet_candidates` | Unique internal finalizer declaration uses `CertifiedFloquetModalCandidate`, retaining the original accepted mode and target distance |
| `source-floquet-tangent-mass-overlap-regression` | `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` | `main` | Unique test entrypoint calls `finalizes_certified_candidates_by_tangent_mass_before_nearest_cap`; direct candidates bypass EPS and do not prove supply, residual certification or refill/NEV; no-provider GHA 37795426460 passed |
| `source-floquet-nev-refill-owner` | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` | Repeated safe EPS attempts increase NEV within fixed initial NCV/MPD, recertify the final pool with the owned positive tangent mass, and account against one cumulative EPS outer-iteration budget; source visible, provider GHA pending |
| `source-floquet-nev-refill-adapter` | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | `solve_sparse_production_modal_payload` | Unique dispatcher routes frequency-window requests into `solve_sparse_production_modal_window_payload`, which propagates cancellation and exposes attempt/budget diagnostics; partial/cancelled outcomes remain explicit; runtime pending |
| `source-floquet-window-count-certificate-diagnostics` | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | `production_window_diagnostics_json` | Preserve raw per-subwindow adapter status/stop reason and report the missing count certificate separately from EPS/refill outcomes |
| `source-floquet-window-count-cap-public-regression` | `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` | `main` | Focused expanded fixture has at least four distinct pre-cap modes; its sole subwindow is status ok/converged before strict policy fails with the explicit certificate reason; provider GHA pending |
| `source-floquet-window-strict-error-consumer` | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `execute_native_cpu_modal_window_from_bloch_floquet_complex_with_provenance` | Non-OK native status returns before parsing C ABI diagnostic modes; these candidates do not become runner artifacts |
| `source-floquet-nev-refill-regression` | `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` | `main` | Test entrypoint calls `refills_native_floquet_nev_before_tangent_mass_cap`; provider-backed EPS regression covers duplicate refill, fixed dimensions, ceilings, cancellation and mass/residual gates; execution pending |
| `source-floquet-window-cross-subwindow-dedup-followup` | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | `solve_sparse_production_modal_payload` | The unique dispatcher enters the native window adapter whose subwindow merge uses the owned positive CSR mass finalizer before the final window cap; production-entry regression pending |


## Rzeczywisty parametr żyromagnetyczny w wynikach (S07/S10, źródła WIP)

Wspólny `PathSolveResult` przechowuje jawny `gamma0_rad_s_per_a_m`,
pochodzący z `FemEigenPlanIR.gyromagnetic_ratio`, bez domyślnej stałej
materiałowej. Gamma0 ma jednostkę rad/(s A/m). Wartość gamma w rad/(s T)
jest obliczana jako gamma0/mu0, zgodnie z istniejącą definicją SI tej noty.
Writers spectrum i mode fields korzystają z tego samego rzeczywistego
parametru. Zanim opublikują wynik, odrzucają wartości niedodatnie,
nieskończone lub powodujące overflow przeliczenia gamma0/mu0.

Oracle Kittela otrzymuje ten sam gamma0 przy obliczaniu oczekiwanej
częstotliwości Larmora/thin-film oraz publikacji parametru fit. Parametr
wchodzi z fizycznego planu także przez adapter bias-field sweep; nie jest
odgadywany z częstotliwości ani ze stałej referencyjnej. Analityka pozostaje
postprocessingiem i nie koryguje modów solvera. Python→ProblemIR,
konwencja fazy, jednostki publicznych pól i dopuszczone lane pozostają takie
same. Poprawka dotyczy wspólnej reprezentacji wyników; nie dowodzi
wykonania FEM CPU/GPU ani zgodności z COMSOL. FDM nie otrzymuje nowej trasy.

Weryfikacja wymaga wartości gamma0 innej niż Py reference, zgodności
spectrum v2/v3, pól modów, parametru i oracle Kittela oraz odrzucenia
invalid gamma0. Wymagane runtime/scientific gates pozostają osobnymi
zadaniami; test źródeł i algebra nie zastępują solvera.

Bezpośredni publisher FEM przed serializacją sprawdza poprawność gamma0
planu i wyniku oraz ich zgodność. Oracle Kittela odrzuca także przepełnioną
częstotliwość obliczoną ze skończonych wejść. Czytnik wiąże gamma każdego
modu ze stałymi wykonania; sama zgodność gamma0=mu0*gamma jest za słaba.
To kontrola kontraktu, a nie odtworzenie operatora.

Ta sama walidacja obowiązuje na wejściu `eigen_execution.rs::execute_fem_eigen_inner`
oraz w niezależnym producerze `eigen_native_artifacts.rs::native_modal_artifacts`.
Single-k CPU/GPU i reference zachowują gamma planu; obliczenie gamma0/mu0
w metadanych następuje dopiero po przejściu wspólnej bramki.

| Source ID | Plik | Symbol | Zakres dowodu |
| --- | --- | --- | --- |
| `source-modal-gamma-single-k` | `crates/fullmag-runner/src/fem/eigen_execution.rs` | `execute_fem_eigen_inner` | Guard przed wykonaniem single-k i metadanymi |
| `source-modal-gamma-native` | `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` | `native_modal_artifacts` | Niezależny guard przed publikacją native |
| `source-modal-gamma-result` | `crates/fullmag-runner/src/eigen/types.rs` | `PathSolveResult` | Required actual plan gamma0 on solved results |
| `source-modal-gamma-owner` | `crates/fullmag-runner/src/eigen/orchestrator.rs` | `run_path_or_single` | Carry actual plan gamma0 without material fallback |
| `source-modal-gamma-guard` | `crates/fullmag-runner/src/eigen/artifacts/common.rs` | `validated_modal_gamma0` | Reject invalid gamma0 and unrepresentable SI conversion |
| `source-modal-gamma-spectrum` | `crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs` | `summarize_mode` | Spectrum metadata uses actual gamma0 |
| `source-modal-gamma-fields` | `crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs` | `write_mode_bundle` | Field metadata uses the same validated gamma0 |
| `source-modal-gamma-kittel` | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `k0_kittel_expected_frequency_hz` | Actual gamma0 and finite positive frequency oracle |
| `source-modal-gamma-fem-publication` | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `eigen_path_publication_gamma0` | Validate result and plan before direct FEM JSON publication |
| `source-modal-gamma-reader` | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `validate_mode_gamma_matches_constants` | Bind mode gamma metadata to execution constants |
| `source-modal-gamma-regression` | `crates/fullmag-runner/src/eigen/artifacts/tests.rs` | `actual_plan_gamma_is_shared_by_spectra_and_mode_fields` | Prepared uncompiled nonreference gamma regression |

## Dowód wybranej krawędzi trackingu (S06/S07, źródła WIP)

Bramka naukowa COMSOL dla C1/A1 wymaga kompletnego zapisu krawędzi,
bez frequency fallback, restartu i przerwy między kolejnymi punktami k.
Przyjęte przypisania muszą korzystać ze spójnej masy P1 i skalarnych
overlapów albo osobnych kątów głównych podprzestrzeni. Historyczna tabela
gałęzi bez rekordu pozostaje czytelna, lecz nie kwalifikuje tego dowodu.
Kontrola strukturalna i declared score nie zastępują replay rzeczywistych
pól/metryki ani fizycznej walidacji crossing/split/merge.
Raport oddziela `campaign_contract_status` od `scientific_qualification`.
Dla C1/A1 brak wykonanego replay hash-bound pól, overlapów i kątów głównych
blokuje globalne `QUALIFIED`, nawet gdy wszystkie kontrakty kampanii przeszły.
Deklaracja autora artefaktu nie może zastąpić wykonania tej bramki.

| Source ID | Plik | Symbol | Zakres dowodu |
| --- | --- | --- | --- |
| `source-comsol-tracking-record-gate` | `scripts/validate_comsol_dispersion_scientific_gate.py` | `_validate_branch_tracking_evidence` | Wykonana kontrola strukturalna, bez replay pól |
| `source-comsol-tracking-qualification` | `scripts/validate_comsol_dispersion_scientific_gate.py` | `validate_case` | Brak field replay blokuje globalne QUALIFIED dla C1/A1 |
| `source-comsol-tracking-record-regression` | `scripts/test_comsol_tracking_provenance_gate.py` | `test_scientific_branch_gate_rejects_complete_table_without_provenance` | RED na poprzednim kodzie, GREEN po wymaganiu provenance |

Każdy nowy punkt gałęzi przechowuje opcjonalny, typowany rekord
`TrackingEdgeProvenance`, utworzony w chwili przyjęcia przypisania.
Rekord zawiera rzeczywistą politykę `ModeTrackingIR` (metoda, próg,
okno częstotliwości w Hz, dopuszczalna luka), źródło score, metrykę,
poprzednią próbkę i liczbę pominiętych próbek. Seed oraz nowa gałąź
mają jawny rodzaj zdarzenia, bez fikcyjnego overlapu.

Dla transportu podprzestrzeni publikujemy rząd, identyfikatory gałęzi
i surowych modów klastra, cosinusy kątów głównych i ich minimum
(bezwymiarowe), a także przejście split→degenerate, degenerate→split
lub degenerate→degenerate. `overlap_prev` pozostaje wtedy pusty:
cosinus kąta głównego nie jest skalarnym overlapem pary modów.
Oba writery serializują ten sam rekord; nie odtwarzają decyzji z braku
overlapu. Historyczny punkt bez rekordu pozostaje bez dowodu krawędzi. Obecny,
lecz uszkodzony rekord jest błędem importu. Nowa gałąź ma source
`modal_overlap_unavailable`; nie jest początkowym seedem. Brak lub
niezgodność polityki daje jawny `missing_or_mixed`, bez domyślnego progu.

Rozszerzenie jest addytywne względem `eigen_branches.v2`; nie zmienia
równań, jednostek, Python→ProblemIR ani dopuszczonych backendów.
Dotyczy wspólnego postprocessingu wyników; nie dowodzi wykonania FEM
CPU/GPU ani nie kwalifikuje FDM. Dotychczasowa skalarna bramka produkcyjna
nie przyjmuje transportu podprzestrzeni jako weighted pair overlap.
Weryfikacja wymaga zgodności obu writerów, zachowania raw mode ID,
faz i signed k, prawdziwej metryki oraz jawnej obsługi luk. Test źródeł
i niezależna algebra nie zastępują managed runtime ani zbieżności.

Mapa implementacji: `crates/fullmag-runner/src/eigen/types.rs` +
`TrackingEdgeProvenance`; `crates/fullmag-runner/src/eigen/tracking.rs` +
`track_branches`; `crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs`
+ `write_branch_bundle_with_sample_namespace`; `crates/fullmag-runner/src/fem/eigen_path.rs` +
`execute_fem_eigen_path_with_producer_identity` (właściciel publikacji ścieżki FEM).

| Source anchor | Path | Symbol | Status |
|---|---|---|---|
| `source-tracking-edge-record` | `crates/fullmag-runner/src/eigen/types.rs` | `TrackingEdgeProvenance` | źródła WIP; bez managed runtime |
| `source-tracking-edge-producer` | `crates/fullmag-runner/src/eigen/tracking.rs` | `track_branches` | źródła WIP; bez managed runtime |
| `source-tracking-edge-writer` | `crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs` | `write_branch_bundle_with_sample_namespace` | źródła WIP; bez managed runtime |
| `source-tracking-confidence-writer-regression` | `crates/fullmag-runner/src/eigen/artifacts/tests.rs` | `tracked_pair_overlap_is_published_as_confidence_in_json_and_csv` | Rzeczywiste `track_branches`→JSON/CSV; bez lokalnego wykonania |
| `source-tracking-edge-signed-regression` | `crates/fullmag-runner/src/eigen/tracking.rs` | `signed_k_tracking_records_split_transport_without_mutating_raw_modes` | źródła WIP; bez managed runtime |
| `source-tracking-edge-artifact-validator` | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `validate_tracking_edge_provenance` | niezależna walidacja rekordu; bez replay pól/runtime |

Opcjonalny rekord jest sprawdzany także przez niezależny czytnik artefaktów:
polityka, zgodność endpointów, liczba pominiętych próbek, metryka/score,
rząd i skończone cosinusy kątów głównych muszą być wzajemnie zgodne.
`previous_raw_mode_index` wiąże także zwykłą parę. Selekcja outputów może
pominąć poprzednik w opublikowanej tablicy; walidator nie zastępuje go
ostatnim zachowanym punktem. Jest to kontrola kontraktu, nie odtworzenie
operatora ani numeryczny dowód ciągłości podprzestrzeni.

## Odtwarzanie metryki trackingu z artefaktów (S07, źródła WIP)

Niezależny postprocessor oblicza iloczyn masowy bez embeddingu producenta:
sumuje lokalne formy Tet4 z eq-de-bv-profile-consistent-mass. Pola fizyczne
demoduluje przez exp(+i k·r), a następnie wyznacza amplitudowy overlap
z eq-de-bv-profile-overlap (nie jego kwadrat). Dla podprzestrzeni stosuje
dwukrotną ortogonalizację w tej samej metryce i SVD macierzy cross-Gram.
Liniowo zależna baza jest błędem; nie wolno zmniejszyć rzędu po cichu.
Helper algebraiczny nie sprawdza hashów artefaktów ani decyzji przydziału.
Adapter odczytu najpierw wykonuje niezależny certyfikat fazy, następnie
ponownie sprawdza SHA-256 tych samych bajtów metadanych i pól. Wyznacza
fingerprint v3 z rzeczywistej siatki i odtwarza uporządkowany support,
kompaktowe Tet4 oraz objętości z jawnej partycji magnetycznej. Rekord masy
musi odpowiadać tej geometrii; sam deklarowany fingerprint nie wystarcza.
Transport ram wyznacza bieżącą bazę przemnożoną przez polarną rotację
Procrustesa cross-Gram. Kolejne overlapy używają tej ramy.
Adapter i algebra nadal nie dowodzą globalnie optymalnego przydziału
branch IDs ani kompletności pasm, więc nie otwierają bramki QUALIFIED.
Replay ścieżki odczytuje także rzeczywiste branches.v2 i spectrum.v2,
wiąże każdy sample/raw ID, częstotliwość zespoloną i signed k z polem.
Przetwarza próbki w kolejności widma; każda grupa degeneracji odczytuje
ramy poprzedniej próbki przed aktualizacją któregokolwiek uczestnika.
Porównuje amplitudowe overlapy, cosinusy kątów głównych i heuristic score
producenta (85% overlap/minimum principal cosine i 15% frequency score).
Frequency score odtwarza zapisane frequency_window_hz lub względną
zmianę częstotliwości, zgodnie z finite_frequency_score_values.
Ten blend pozostaje wynikiem przypisania używanym do wyboru krawędzi.
Publikowane `tracking_confidence` ma osobną semantykę: dla krawędzi z
rzeczywistym skalarnym overlapem (ważonym lub euklidesowym) jest równy
`overlap_prev`, a nie ważonemu wynikowi dopasowania. Gdy brak skalarnego
overlapu — przy frequency fallback lub transporcie podprzestrzeni — confidence
zachowuje wynik przypisania. Początkowy seed ma confidence $1$; restart jako
nowa gałąź ma $0$. Regresja przeprowadza rzeczywiste `track_branches` przez
zapis JSON i CSV, aby oba pola zachowały te odrębne wartości.
Zgodność algebraiczna wykorzystuje tolerancję bezwymiarową 1e-9;
nie jest tolerancją residualu eigenproblem ani zgodności z analityką.
Brak zależnej historii gałęzi lub pola oznacza brak pełnego replay.
Restart i gap wymagają odtworzenia ostatniej ramy, dopuszczalności poprzednika
oraz przydziału nowego branch_id; nie zastępują dowodu kompletności widma.
Odczyt z dysku wymaga pól każdego raw modu zapisanego w widmie, także
kandydatów nieprzypisanych do wybranych gałęzi. Każde pole jest wiązane
z sample/raw ID, podpisanym wektorem k i zespoloną częstotliwością widma.
Część rzeczywista częstotliwości każdego eksportowanego kandydata musi
być dodatnia, zgodnie z kontraktem dodatniej gałęzi widma benchmarku.
Pokrycie eksportowanego zbioru kandydatów nie dowodzi kompletności widma
solvera ani optimum globalnego przydziału. Brak pola kandydata blokuje
replay, zamiast pozostawić je poza kontrolą. Kampania musi jawnie zachować
wszystkie pola przez FULLMAG_COMSOL_DISPERSION_ALL_FIELDS=1; domyślny
ograniczony eksport nie wystarcza do replay całej ścieżki.
Sukces ma osobny status metryki; brak replay przydziału/cluster selection
nadal blokuje naukową kwalifikację C1/A1. Mechanizm nie zmienia solvera,
publicznego Python/IR ani metod fizycznych i nie dowodzi zbieżności.
### Przypisanie raw modów wewnątrz wybranej podprzestrzeni

Po transporcie Procrustesa odtwarzana jest macierz wag używana przez
producenta do przypisania raw ID do poprzednich gałęzi:

```{math}
:label: eq-tracking-subspace-raw-assignment
w_{ij}=\left|\left(Q_{\mathrm{rot}}\right)_{ji}\right|,
\qquad
\pi_\star\in\operatorname*{arg\,max}_{\pi\in\Pi_d}
\frac{1}{d}\sum_{i=1}^{d}w_{i,\pi(i)}.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $Q_{\mathrm{rot}}$ | Unitarna rotacja bieżącej bazy do poprzedniej ramy w metryce masy | $1$ |
| $w_{ij}$ | Moduł współczynnika rotacji, wiersz poprzedniej gałęzi i kolumna bieżącego raw modu | $1$ |
| $d$, $i$, $j$ | Rząd grupy i indeksy elementów poprzedniej/bieżącej bazy | $1$ |
| $\Pi_d$ | Zbiór permutacji dla grupy rzędu d | $1$ |
| $\pi$, $\pi_\star$ | Przypisanie gałęzi do raw modów i przypisanie optymalne | $1$ |
| $\epsilon_{\mathrm{assign}}$ | Tolerancja średniej wagi optimum, równa 1e-9 | $1$ |

Niezależny algorytm Hungarian wyznacza maksimum sumy wag bez enumerowania
wszystkich permutacji. Odczytane przypisanie jest sprawdzane względem optimum
po podzieleniu sumy przez rząd grupy. Przy równoważnych optimach różne
permutacje są dopuszczalne w tej tolerancji i jawnie raportowane; nie wolno
odrzucać poprawnej degeneracji wyłącznie przez inny tie-break SVD/Hungarian.
Nieoptymalna permutacja jest błędem, nawet gdy principal cosines i score
są identyczne. Tolerancja dotyczy roundtripu algebry, nie błędu fizycznego.

Zakres: grupa o równym rzędzie co najmniej dwa, poprawne niezależne bazy,
ta sama metryka P1 i niezmienne hash-bound pola. Testy maksimum porównują
małe macierze z niezależną enumeracją permutacji. Całość jest postprocessingiem
CPU; publiczny Python/IR i solver nie zmieniają się. Replay wewnętrznego
przypisania nie dowodzi poprawności wyboru grup ani globalnego przydziału
pair edges z pełnego zbioru kandydatów; te bramki pozostają NOT VERIFIED.

Weryfikacja grupowania używa całego widma sąsiednich próbek. Odtwarza
bieżącą prywatną politykę producenta: sortowanie części rzeczywistej,
urojonej oraz ID gałęzi po poprzedniej stronie i pozycji modu w widmie
po bieżącej stronie; odległość zespolona względem pierwszego elementu
klastra nie przekracza sumy 1e-6 Hz i 1e-4 razy większy moduł
częstotliwości (z dolną skalą 1 Hz). To heurystyka trackingu, nie kryterium
fizycznej degeneracji. Grupowanie względem kotwicy nie jest domknięciem
przechodnim bliskości sąsiednich częstotliwości.
Dla split→degenerate i degenerate→split grupa singletów jest wybierana
według odległości zespolonej od środka klastra; remis na granicy wyboru
w tolerancji 1e-12 razy większa odległość (z dolną skalą 1 Hz) odrzuca
kandydata. Zapisane grupy i indeksy klastrów muszą należeć do tego zbioru.
Legalny kandydat nadal nie dowodzi wyboru globalnego optimum; takie
przypisanie pozostaje osobną bramką, także po poprawnym grupowaniu.

Niezależny replay wyboru oblicza principal angles i transport wszystkich
legalnych kandydatów w tej samej metryce P1. Odrzuca zależne bazy i grupy
poniżej principal-angle floor. Dla każdej pary klastrów zachowuje pierwszy
kandydat o największym score, następnie dopasowuje klastry z jawnymi
dummy rows/columns; po dopasowaniu usuwa grupy nakładające się na wcześniej
wybraną grupę, zgodnie z bieżącą polityką producenta. To odtworzenie
heurystyki producenta, nie twierdzenie o globalnym optimum problemu grup
z ograniczeniem rozłączności.
Gałęzie i mody zużyte przez wybrane grupy są wyłączone z generowania
pojedynczych krawędzi. Pozostałe krawędzie używają poprzednich ram,
overlap floor i zapisanego frequency window. Metoda overlap_greedy zachowuje
sortowanie score/branch ID/mode slot; overlap_hungarian używa dummy oraz
kary dla krawędzi niedozwolonych. Brak pola lub poprzedniej ramy nie
uruchamia fallbacku częstotliwościowego. Samo obliczenie przewidywanego
dopasowania nie zamyka bramki: potrzebne jest jeszcze związanie go
z zapisaną tabelą i replay wszystkich kolejnych ram ścieżki.

Porównanie tabeli wymaga pełnego pokrycia bieżącego widma gałęziami oraz
tego samego zestawu wybranych grup, ich przejść i indeksów. Równoważne
przypisania Hungarian dopuszcza zgodna średnia suma score w tolerancji
algebry 1e-9, po niezależnym sprawdzeniu każdej zapisanej krawędzi.
Greedy musi odtworzyć wybraną parę zgodnie z deterministyczną polityką.
Ramy grup sprawdzane są w metryce masy do nieistotnej fazy; kolejny krok
używa już sprawdzonej ramy zapisanej ścieżki. Pełny replay nie może
pomijać gałęzi będących alternatywnymi kandydatami. Brak lub rozbieżność
pozostają osobnym wynikiem assignment replay, a nie zmianą residualu.

Aktualny certyfikat obejmuje kompletne historie wszystkich gałęzi, również
przy zmiennej liczbie modów, narodzinach, zanikach i dopuszczonych przerwach.
Raport jawnie podaje
replayed_branch_scope=all_candidates; selected_branch_ids nie ogranicza
kandydatów globalnego przydziału. complete_history wymaga wykonanego
branch_lifecycle_replay dla każdej próbki. Ostatnia rama i częstotliwość są
zachowane w przerwie; gap jest liczbą pominiętych pozycji ścieżki, nie różnicą
sample_index. Po przekroczeniu max_branch_gap stara gałąź nie uczestniczy
w dopasowaniu. Niezajęte sloty modów otrzymują kolejne branch_id w kolejności
solvera i confidence równe zeru. Gdy dopuszczone ramy pochodzą z różnych
próbek, podprzestrzenie są wyłączone, lecz dopasowanie par nadal działa
(`scripts/comsol_tracking_replay.py::replay_recorded_frames`,
`scripts/comsol_tracking_global.py::reconstruct_global_assignment`).
Równoważne optimum pair Hungarian
i raw assignment wewnątrz tej samej grupy jest akceptowane. Alternatywny
zestaw grup lub zestaw narodzin przy remisie pozostaje odrzucany; nie wolno
interpretować takiego odrzucenia jako dowodu błędu fizycznego solvera.

assignment_replay=pass wymaga również zgodności początkowych branch_id z
indeksami slotów modów w pierwszej próbce, dokładnie w kolejności zwróconej
przez solver (`scripts/comsol_tracking_replay.py::verify_initial_assignment`).
Nie jest to sortowanie po częstotliwości ani po raw_mode_index. Błędny seed
zachowuje osobny wynik metryk, lecz wyklucza certyfikat przypisania.
assignment_replay=pass wymaga zgodności wszystkich kroków, ich grup i ram,
nie tylko lokalnych score. Główna bramka sprawdza liczbę i kolejność kroków
względem widma, a początkowy snapshot hashy obejmuje metadane, widmo,
tabelę gałęzi oraz nagłówek i vector.bin każdego kandydata. Brak początkowych
bajtów nie pozwala zaakceptować później utworzonego pola. Certyfikat
przypisania zamyka wyłącznie tę kontrolę: residual, faza, kompletność widma,
analityka i zbieżność pozostają odrębnymi wymaganiami. Syntetyczne testy
nie kwalifikują rzeczywistej kampanii FEM ani danych COMSOL.

Po degeneracji konieczny jest dodatkowo replay przetransportowanej ramy;
raw-to-raw overlap nie zastępuje tego replay. Ogólna kwalifikacja naukowa
rzeczywistych kampanii C1/A1 pozostaje NOT VERIFIED. Jest to diagnostyka CPU, bez zmiany Python/IR,
solverów i kwalifikacji urządzeń.

Zapis pola Cartesian global_xyz i metryka trackingu są oddzielne. Pole
obejmuje pełną siatkę; metryka identyfikuje uporządkowane fizyczne węzły
magnetyczne, tetrahedry w ich indeksacji kompaktowej i objętości w m³.
Przy odczycie adapter Gamma wybiera te same węzły z pełnego pola; nie
obcina pola do liczby węzłów i nie zastępuje metryki normą euklidesową.
Rekord tracking_consistent_p1_metric.v1 ma jawny definition_id, tożsamość
siatki, physical_node_indices, tetra oraz volumes_m3. Konstruktor
ponownie sprawdza dodatniość objętości, pokrycie i indeksy. Wadliwy rekord,
niezgodna tożsamość siatki, nieznana wersja lub jednoczesne wagi diagonalne
kończą odczyt błędem. Brak rekordu w starszych artefaktach zachowuje ich
jawny legacy zakres; nie dowodzi consistent-mass qualification.

Równania pozostają eq-de-bv-profile-consistent-mass i eq-de-bv-profile-overlap.
Nie zmienia to fizyki, publicznego Python/ProblemIR ani solvera FEM CPU/GPU.
To postprocessing CPU. Parametry i jednostki pozostają jak w powyższej
sekcji consistent P1; objętości mają SI m³, indeksy są bezwymiarowe.
Bramki: roundtrip metryki, odrzucenie uszkodzonego rekordu i poprawna
selekcja węzłów Gamma, następnie kompilacja/runtime i walidacja naukowa.
Źródła WIP nie stanowią dowodu wykonania tych bramek.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-tracking-consistent-persist | `crates/fullmag-runner/src/eigen/tracking_mass.rs` | `from_artifact_json` |
| source-tracking-consistent-reload | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `parse_bias_field_mode_vectors` |
| source-tracking-consistent-publication | `crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs` | `ModeArtifact` |
| source-comsol-tracking-metric-algebra | `scripts/comsol_tracking_metric.py` | `principal_cosines` |
| source-comsol-tracking-metric-tests | `scripts/test_comsol_tracking_metric.py` | `test_rotated_degenerate_basis` |
| source-comsol-tracking-frame-transport | `scripts/comsol_tracking_metric.py` | `transport` |
| source-comsol-tracking-field-reader | `scripts/comsol_tracking_fields.py` | `load_tracking_fields` |
| source-comsol-tracking-field-tests | `scripts/test_comsol_tracking_fields.py` | `test_actual_certificate_and_geometry` |
| source-comsol-tracking-path-replay | `scripts/comsol_tracking_replay.py` | `replay_recorded_frames` |
| source-comsol-tracking-disk-replay | `scripts/comsol_tracking_replay.py` | `replay_tracking_fields` |
| source-comsol-tracking-replay-tests | `scripts/test_comsol_tracking_replay.py` | `test_disk_signed_path_replays_actual_edges` |
| source-tracking-subspace-assignment-weights | `scripts/comsol_tracking_metric.py` | `transport_with_assignment_weights` |
| source-tracking-assignment-optimum | `scripts/comsol_tracking_assignment.py` | `maximum_weight_assignment` |
| source-tracking-assignment-replay | `scripts/comsol_tracking_replay.py` | `replay_recorded_frames` |
| source-tracking-assignment-enumeration | `scripts/test_comsol_tracking_assignment.py` | `test_small_square_and_rectangular_against_enumeration` |
| source-tracking-frequency-group-candidates | `scripts/comsol_tracking_clusters.py` | `frequency_group_candidates` |
| source-tracking-frequency-cluster-tests | `scripts/test_comsol_tracking_clusters.py` | `test_anchor_grouping_does_not_chain_neighbors` |
| source-tracking-global-policy-prediction | `scripts/comsol_tracking_global.py` | `reconstruct_global_assignment` |
| source-tracking-global-policy-tests | `scripts/test_comsol_tracking_global.py` | `test_hungarian_and_greedy_policies_differ_on_counterexample` |
| source-tracking-global-table-certificate | `scripts/comsol_tracking_replay.py` | `verify_global_prediction` |
| source-tracking-global-table-regression | `scripts/test_comsol_tracking_replay.py` | `test_locally_valid_but_globally_inferior_pair_assignment_is_rejected` |
| source-tracking-initial-field-snapshot | `scripts/validate_comsol_dispersion_scientific_gate.py` | `_tracking_input_hashes` |


### Jawny eksport wszystkich modów solvera

SaveMode(all_modes=True) i study.save("mode", all_modes=True) oznaczają
eksport każdego modu obecnego w rzeczywistym wyniku dla wybranych próbek.
Nie oznaczają range(requested_count) ani kompletności fizycznego widma.
Raw IDs pozostają niezmienione. Parametr ma typ bool, domyślnie False,
jednostkę $1$ i mapowanie study.sampling.outputs[].all_modes w ProblemIR dla
kind=eigen_mode. True nie może być łączone z indices lub branches;
niewłaściwy typ lub konflikt selektorów jest błędem. sample_indices
i sample_labels zachowują dotychczasowe znaczenie.

False jest pomijane w JSON, a brak pola odtwarza False. Istniejące
selektory raw i branch zachowują semantykę. Eksport Python zachowuje
all_modes=True. Rozstrzygnięcie selektora następuje po solve na rzeczywistych
identyfikatorach, bez renumeracji i bez żądania dodatkowych eigenpairs.
Wewnętrzny tracking zachowuje wektory magnetyczne wszystkich kandydatów
wymaganych do przypisania gałęzi, a także `phi_vector` i payloady
certyfikacyjne. Ten zakres wewnętrzny nie oznacza publicznego eksportu
potencjału: `potential_full.bin`, `demag_element_full.bin` i ich manifest są
tworzone przed rozwinięciem potencjału tylko dla rzeczywiście zwróconych
modów wybranych przez `SaveMode` dla danej próbki. `all_modes=True` wybiera
wszystkich kandydatów obecnych w wyniku; jawne raw IDs ograniczają rozwinięcie
do tych identyfikatorów. Selektor gałęzi zachowuje magnetyczne wektory i surowe
payloady potencjału do zakończenia trackingu; rozwinięcie `phi` i utworzenie
sidecarów następują dopiero dla raw IDs wybranych po mapowaniu gałęzi. Przy
połączeniu selektorów jawne raw IDs mogą być obsłużone wcześniej, a wyniki
gałęzi po mapowaniu; wspólny sample/raw-mode path jest deduplikowany.
Bez `SaveMode` nie powstają publiczne sidecary fizycznego potencjału.

Wersjonowanie żądania procesu worker i schemat raportu pozostają osobnymi
kontraktami. Worker używa tokenu protokołu V2 dla nowego żądania selektorów,
ale publiczny raport nadal ma kształt `ProcessPoolReportV1` i schemat
`fullmag.parallel-execution-report.v1`; pole `protocol` dopuszcza wyłącznie
token worker V1 albo V2. Bezpośredni raport nadal nie zawiera
`terminal_state`, więc jego kompletność wykonania pozostaje
`not_verified`. Dziennik admission zachowuje własny terminalny stan.

To backend-neutralny zamiar wyjścia dla istniejących ścieżek eigensolve,
bez zmiany operatora, jednostek, requested/resolved device, fallbacku ani
kwalifikacji FDM CPU/GPU lub FEM CPU/GPU. Większy eksport może zwiększyć
koszt pamięci i storage. Publiczny parametr nie stanowi dowodu obsługi
samego eigensolve na niewspieranej konfiguracji. Kompilacja i managed
runtime nowego selektora wymagają osobnej weryfikacji.

| Parametr | Typ i default | SI | Walidacja | Python→IR |
|---|---|---|---|---|
| SaveMode.all_modes / study.save.all_modes | bool, False | $1$ | Dokładny bool; True wyklucza indices i branches | study.sampling.outputs[].all_modes, kind=eigen_mode; False pomijane |

| Source ID | Źródło | Symbol |
|---|---|---|
| source-all-mode-python | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveMode` |
| source-all-mode-ir | `crates/fullmag-ir/src/study.rs` | `OutputIR` |
| source-all-mode-selection | `crates/fullmag-runner/src/eigen/output_selection.rs` | `select_eigen_outputs` |
| source-all-mode-native-result | `crates/fullmag-runner/src/fem/eigen_output.rs` | `requested_mode_indices_for_result` |
| source-all-mode-path-retention | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `eigen_path_candidate_mode_indices` |
| source-all-mode-native-potential-publication | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `physical_potential_artifacts_for_path_selector` |
| source-all-mode-path-execution-selector | `crates/fullmag-runner/src/fem/eigen_execution.rs` | `execute_fem_eigen_path_single_k` |
| source-all-mode-path-publication-regression | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `path_potential_sidecars_follow_public_sample_and_mode_selection_before_expansion` |
| source-all-mode-posttracking-potential-publication | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `materialize_selected_path_physical_potential_artifacts` |
| source-all-mode-posttracking-potential-regression | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `native_floquet_candidates_flow_through_tracking_selection_and_deferred_sidecars` |
| source-all-mode-reference-mode-identity-regression | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `reference_mode_bundle_raw_identity_without_index_is_accepted_and_dual_identity_must_agree` |
| source-all-mode-worker-request-v2 | `crates/fullmag-runner/src/fem/eigen_k_worker.rs` | `EigenKWorkerRequestV2` |
| source-all-mode-worker-publication-regression | `crates/fullmag-runner/src/fem/eigen_k_worker.rs` | `v2_worker_request_keeps_tracking_and_publication_selectors_separate` |
| source-all-mode-process-pool-v2 | `crates/fullmag-runner/src/eigen/k_process_pool.rs` | `prepare_request` |
| source-all-mode-worker-v2-protocol | `crates/fullmag-runner/src/fem/eigen_k_worker.rs` | `EIGEN_K_WORKER_PROTOCOL_V2` |
| source-all-mode-process-pool-report-v1-shape | `crates/fullmag-runner/src/eigen/k_process_pool.rs` | `ProcessPoolReportV1` |
| source-all-mode-report-v1-v2-validator | `scripts/validate_parallel_execution_report.py` | `SUPPORTED_REPORT_PROTOCOLS` |
| source-all-mode-report-protocol-regression | `scripts/test_validate_parallel_execution_report.py` | `test_supported_v1_and_v2_protocols_keep_direct_completion_unverified` |
| source-all-mode-python-test | `packages/fullmag-py/tests/test_problem_ir.py` | `test_save_all_modes_has_explicit_intent_without_assumed_raw_ids` |

### Integralność legacy odczytu pól i wag

Odczyt Kittel nie może usuwać wadliwych wag, dopisywać zerowych
komponentów ani obcinać globalnego pola do arbitralnej długości wag.
Legacy diagonalne wagi wymagają dodatnich, skończonych wartości oraz
dokładnie jednego wpisu na węzeł odczytanego pola. Artefakt z krótszym
wektorem wag bez jawnego odwzorowania jest odrzucany jako niejednoznaczny,
a nie reinterpretowany jako prefix węzłów magnetycznych. Jawnie podane
real/imag muszą występować razem i być niepuste; binary jest alternatywą
dla nieobecnych pól, nie naprawą wadliwych tablic. Sample/raw identity
z metadanych musi zgadzać się z żądanym modem. Adapter Gamma odrzuca
metadane z niezerowym k. Te reguły dotyczą integralności postprocessingu
CPU, nie dowodzą solvera ani zgodności z analityką.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-kittel-mode-identity-reader | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `find_bias_field_mode_metadata` |


### Selekcja Gamma z metryką zadeklarowaną w pamięci

Zadeklarowane wagi diagonalne obowiązują także przed zapisem artefaktów.
Nieudana projekcja ważona zwraca brak obserwabli, nigdy wynik
euklidesowy ani wynik z innego pola. Podobnie niepoprawny reduced_vector
nie przełącza selektora na lifted payload. Lifted real/imag muszą mieć
tę samą dodatnią liczbę węzłów; brak części zespolonego pola nie jest
synonimem pola zerowego. Gałąź bez obserwabli jednorodności jest
niekwalifikowalna przez selektor Kittel. Jest to integralność metryki,
nie nowa fizyka ani zmiana API/ProblemIR. Runtime pozostaje nieweryfikowany.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-kittel-declared-metric-selector | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `k0_kittel_mode_uniformity_score` |


### Nieobliczony certyfikat periodycznego modu

max_periodic_seam_mismatch dotyczy zespolonego modu, nie stanu równowagi
ani certyfikatu geometrii. Bez niezależnego obliczenia na sparowanych
węzłach nie wolno podstawiać zera. Eksport CSV pozostawia nieobliczoną
miarę pustą, a summary ma status partial i qualification NOT VERIFIED.
Osobny frequency_comparison_status opisuje wyłącznie zgodność z
analityką. Pełna bramka artefaktów nadal odrzuca brak tej wymaganej
miary. Nie zmienia to progu residual ani częstotliwości solvera.
Implementacja obliczenia seam z par/pełnego pola pozostaje otwarta.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-kittel-unmeasured-seam-publication | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `k0_kittel_validation_auxiliary_artifacts` |


### Brak residualu w typed Kittel fit

`fmr/kittel_fit.v1.json.validation_status` opisuje wynik postsolve porównania
Kittela, ale nie może oznaczać `passed` tylko na podstawie częstotliwości.
Każdy wybrany punkt musi mieć dostępny residual `residual_relative_l2`, który
jest skończony i nieujemny. Nie zmienia to progu ani źródła akceptacji
oryginalnego residualu solvera; jest bramką dostępności wymaganej miary.

Jeżeli porównanie częstotliwości nie spełnia zadeklarowanej tolerancji,
`validation_status=failed` ma pierwszeństwo. Gdy częstotliwość jest w tolerancji,
ale któremukolwiek punktowi brakuje poprawnego residualu,
`validation_status=not_verified`; taki punkt zachowuje dane diagnostyczne i ma
`status=partial`. Tylko komplet residuali oraz zgodność częstotliwości pozwalają
na `validation_status=passed`. Typed fit nadal pozostaje `partial` i
`complete=false`, gdy brakuje covariance/conditioning.

Brak residualu nie przerywa zapisu pozostałych artefaktów. K0 summary zachowuje
`frequency_comparison_status` jako wyłącznie porównanie częstotliwości, lecz
raportuje brak wybranego residualu w `missing_evidence`; nieobecna walidacja
Kittela nadal nie generuje artefaktu Kittela. Weryfikator produkcyjny wymaga
skończonego residualu w każdym wybranym wierszu. Nie podstawiamy zera i nie
zmieniamy tolerancji.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-kittel-fit-residual-status | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `build_kittel_fit_artifact_impl` |
| source-kittel-fit-residual-status-regression | `crates/fullmag-runner/src/eigen/artifacts/tests.rs` | `kittel_fit_validation_requires_finite_residual_for_each_selected_point` |

### Pomiar seam magnetycznego pola modu (źródła WIP)

Dla klas periodycznych porównujemy fizyczny zespolony wektor Cartesian
węzła slave z polem reprezentanta pomnożonym przez stosunek faz
mapy redukcji. Envelope przywracamy do pola fizycznego zgodnie z
eq-fem-dynamic-ansatz i przyjętym exp(-i k·r). Defekt to maksimum
normy różnicy XYZ podzielone przez maksimum normy XYZ pola na fizycznych
węzłach magnetycznych. Jest bezwymiarowy i niezależny od globalnej
amplitudy/fazy modu. Skalowanie przed obliczeniem ogranicza overflow.
Brak sparowanych węzłów lub pola nie daje certyfikatu zerowego.
Rekord jest związany z mesh fingerprint, sample/raw ID, k i częstotliwością.
To kontrola magnetycznego pola, nie phi ani certyfikat airboxu lub
równowagi. Działa w postprocessingu CPU; solver i publiczny Python/IR
pozostają bez zmian. Wymaga kompilacji, regresji fazy i runtime;
nie kwalifikuje pełnej ścieżki ani GPU.


```{math}
:label: eq-periodic-mode-seam-relative
\epsilon_{\mathrm{seam}} =
\frac{\max_{j\ne r(j)}\left\|\mathbf v_j-
\frac{p_j}{p_{r(j)}}\mathbf v_{r(j)}\right\|_2}
{\max_j\left\|\mathbf v_j\right\|_2}.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf v_j$ | Fizyczny Cartesian mod na węźle magnetycznym, wspólna dowolna amplituda | $1$ |
| $p_j$ | Faza klasy periodycznej | $1$ |
| $r(j)$ | Indeks reprezentanta klasy | $1$ |
| $\epsilon_{\mathrm{seam}}$ | Względny defekt magnetycznego seam | $1$ |

Pomiar jest odrębnym dowodem od akceptacji: sam dodatni skończony wynik
nie dowodzi dostatecznie małego defektu. Bramka tolerancji, phi/airbox i
runtime pozostają otwarte. Qualification pozostaje NOT VERIFIED.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-periodic-mode-seam-metric | `crates/fullmag-runner/src/eigen/tracking_mass.rs` | `periodic_seam_relative` |
| source-periodic-mode-seam-reader | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | `k0_kittel_mode_periodic_seam` |


## Niezależny pomiar fazy 19 archiwalnych modów DE/BV

Narzędzie `scripts/audit_de_bv_periodic_seams.py` korzysta z jawnych
periodic_node_pairs i translacji periodic_boundary_pairs w siatce.
Loader `load_record` wiąże finalny porządek siatki z tożsamością
opublikowanego pola, sprawdza hashe binarnego payloadu i oryginalny
full descriptor residual ≤ 10⁻⁸. Odtwarzanie fizycznego pola z envelope
wykorzystuje tę samą konwencję przestrzenną co eq-fem-dynamic-ansatz.
Porównanie odbywa się na zadeklarowanych parach A→B, nie przez
zgadywanie par na podstawie współrzędnych. Położenia muszą zgadzać
się z translacją w granicach zapisanej tolerancji siatki.

| Zakres | Wynik |
|---|---|
| DE: 9 modów, po 28 par magnetycznych | max defekt względny 3.227404597226726e-16 |
| BV: 10 modów, po 28 par magnetycznych | max defekt względny 3.3852323788985243e-16 |
| Świadomie odwrócony znak fazy | defekt 0.1598…1.68294 |
| Świadomie pominięta faza | defekt 0.07997…0.95885 |
| Regresje narzędzia interpretowanego | 7 PASS |

Warunki: film 40 × 40 × 10 nm, Ms=800000 A/m, A=13 pJ/m,
gamma0=221100 m/(A·s), B0=0.1 T w +x, PBC x/y, demag airbox
z phi=0 na górze/dole, DE k_y i BV k_x, k=2…25 rad/µm.
Python/ProblemIR i częstotliwości nie zostały zmienione. To diagnostyka
historycznych FEM CPU pól, nie nowy solve, FEM GPU ani FDM.

Wnioski: fazowe zszycie magnetycznych pól tych 19 modów jest zgodne
z deklarowaną konwencją na jawnych parach. Ta kontrola nie tłumaczy
całej różnicy względem analityki i nie dowodzi phi/airbox, zbieżności
siatki ani kompletności pasm. Pair-based diagnostic nie jest wykonaniem
nowego root-class-based Rust ani jego testów. Qualification NOT VERIFIED.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-archived-magnetic-pair-seams | `scripts/audit_de_bv_periodic_seams.py` | `magnetic_pair_seams` |
| source-archived-bound-mode-loader | `scripts/compare_de_bv_mode_profiles.py` | `load_record` |


## Archiwalne phi i H_demag: zgodność pól DE/BV

Narzędzie `scripts/audit_de_bv_potential_fields.py` bada full_physical_phasor
phi w SI A oraz elementowe H_demag w SI A/m. Wymaga pełnego pola
na tej samej końcowej siatce, właściwego układu f64 real/imag, poprawnych
hashy i zgodnych operator_input_signature/phase_constraint. Część
rekonstrukcyjna eq-fem-full-bloch-demag jest sprawdzana niezależnie
przez rozwiązanie lokalnego 3 × 3 układu na każdym tetraedrze P1.
Nie rozwiązuje to ponownie Poissona; gradient wykorzystuje zapisane phi.

| Zakres | Wynik |
|---|---|
| DE: 9 modów, pełne phi na 1980 węzłach | max defekt fazy 2.2887833992611187e-16 |
| BV: 10 modów, pełne phi na 1980 węzłach | max defekt fazy 2.2887833992611187e-16 |
| Każdy mod: 1195 jawnych par periodycznych | Wszystkie objęte pomiarem |
| Zewnętrzne płaszczyzny z: po 10 węzłów/mod | phi dokładnie zerowe |
| H_demag vs niezależny gradient phi, objętościowa norma L2 | max względny defekt 1.6741805960076105e-15 |
| H_demag vs gradient, maksimum względne | max defekt 2.026141543011879e-14 |
| Interpretowane regresje gradientu | 6 PASS |

Warunki filmu/materialu są identyczne z wcześniejszą kontrolą 19 modów:
40 × 40 × 10 nm, Ms=800000 A/m, A=13 pJ/m, gamma0=221100 m/(A·s),
B0=0.1 T w +x, PBC x/y, padding airboxu 2 µm z obu stron,
DE k_y/BV k_x, k=2…25 rad/µm. Publiczny Python/ProblemIR pozostaje
bez zmian. To historyczne FEM CPU dane; brak dowodu FEM GPU lub FDM.

Kontrola potwierdza spójność fazy pełnego phi i opublikowanej rekonstrukcji
H_demag. Nie dowodzi niezależnego rozwiązania równania Poissona,
interfejsowego weak flux, zbieżności airboxu/siatki, zgodności z COMSOL
ani wykonania nowego Rust. Phi=0 na geometrycznych zewnętrznych
płaszczyznach jest kontrolą danych tego benchmarku, nie uniwersalnym
identyfikatorem Dirichlet dla dowolnego modelu. Nie zwiększa liczby
częstotliwości; qualification NOT VERIFIED.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-archived-potential-gradient | `scripts/audit_de_bv_potential_fields.py` | `gradient_diagnostics` |
| source-archived-potential-inspection | `scripts/audit_de_bv_potential_fields.py` | `inspect` |


## Archiwalny Poisson DE/BV: niespójna normalizacja pary — 2026-09-30

Niezależne narzędzie `scripts/audit_de_bv_poisson_weak.py` składa słabą
postać eq-fem-full-bloch-weak na pełnych tetraedrach P1: całkę gradientów
phi oraz źródło Ms razy średnia węzłowej magnetyzacji w elementach filmu.
Stosuje sprzężone zespolone ograniczenie Floqueta C^H i usuwa klasy
Dirichleta na zewnętrznych płaszczyznach z tego benchmarku. Residual to
norma różnicy obu wolnych wektorów słabych podzielona przez sumę ich norm.
Ms jest w A/m, phi w A, m jest bezwymiarowe; norma względna jest bezwymiarowa.
Warunki: film 40 × 40 × 10 nm, Ms=800000 A/m, A=13 pJ/m,
gamma0=221100 m/(A·s), B0=0.1 T w +x, airbox 2 µm na stronę,
PBC x/y, DE k_y i BV k_x, k=2…25 rad/µm. Python/ProblemIR bez zmian.

13 z 19 par daje residual około 3e-15…1.4e-14. Pozostałe 6:
BV k=7,15,20,22,25 i DE k=7 rad/µm daje 0.089…0.1664.
Diagnostyczne dopasowanie dodatniej skali źródła 1.195…1.399 redukuje
ich defekt do około 3e-15…9e-15. Dopasowania nie zastosowano do danych,
nie zmieniono kryterium 1e-8 ani częstotliwości. To diagnostyka błędu,
nie sposób akceptowania modów.

Przyczyna w aktualnym źródle: deduplicate_slepc_modes_by_overlap kopiował
cały SLEPcModalAcceptedMode, po czym nadpisywał tylko mode_vector
normalizowaną kopią z deduplikatora. Potencjał i certyfikaty pozostawały
w pierwotnej skali. Oba wywołania, dense i sparse/shared-domain, używają
tej funkcji. Zamierzona poprawka zachowuje całą oryginalną parę q/phi;
normalizowane kopie służą wyłącznie porównaniu overlap. Rust może następnie
normalizować oba pola tą samą skalą. Kinematyka i eigenvalues bez zmian.

To potwierdzony błąd publikacji w bieżącym kodzie i silne wyjaśnienie
niespójności historycznych pól. Historyczna biblioteka nie ma pełnego
powiązania z obecnym źródłem, więc pochodzenie tych 6 artefaktów wymaga
nowego uruchomienia. Błąd sam nie wyjaśnia różnicy częstotliwości wobec
analityki n=0. Wcześniejsze pomiary seam oraz H=-grad(phi) nadal są prawdziwe,
ale nie dowodzą zgodności phi ze źródłem m. Te 6 par nie kwalifikuje się
jako spójne sprzężone pola. Nie zastępuje to pełnego residualu magnetycznego,
zbieżności siatki/airboxu, kontroli Gamma, COMSOL ani parytetu GPU.
Poprawka C++: WIP, managed runtime NOT VERIFIED; brak nowego solve.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-archived-poisson-weak | `scripts/audit_de_bv_poisson_weak.py` | `weak_poisson_residual` |
| source-archived-poisson-inspection | `scripts/audit_de_bv_poisson_weak.py` | `inspect` |
| source-coupled-mode-window-dedup | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | `std::vector<SLEPcModalAcceptedMode> deduplicate_slepc_modes_by_overlap` |

Interpretowane regresje słabej postaci: 10 PASS, w tym jednostronna
normalizacja oraz jawna macierz C^H z Dirichletem. To nie wykonanie C++.

## Integralność parametrów diagnozy archiwalnej

Parametry referencji i kontroli Poissona odczytane z rekordu porównania muszą
odpowiadać hash-bound `metadata.json` tego samego runu. Kontrolujemy
magnetyzację nasycenia [A/m], sztywność wymiany [J/m], stałą żyromagnetyczną
[m/(A s)], grubość filmu [m], pole bias [A/m], orientację DE/BV i zewnętrzny
warunek Dirichleta. Pole bias odtwarza się z indukcji [T] i przenikalności
próżni [T m/A]. Tolerancja 32 epsilon maszynowych dotyczy tylko roundoff
przeliczenia jednostek; nie jest tolerancją dopasowania fizycznego.
Brakujące, niezgodne i niefinitywne parametry odrzucamy przed obliczeniem.
Konieczny jest jeden jawny hash metadanych; sprawdzane są dokładnie bajty
przekazane do parsera. Kontrola dotyczy jednego uniform-film DE-SMOKE;
nie rozszerza zakresu na niejednorodne materiały ani dowolną równowagę.

Regresja: zgodny rekord DE/BV jest akceptowany, zmiana każdego parametru,
orientacji lub warunku zewnętrznego jest odrzucana. Ponowna kontrola 19
archiwów zachowuje diagnozę 13 spójnych i 6 niespójnych par pól; nie jest
nowym wykonaniem solvera ani dowodem zbieżności.

| Source map ID | Źródło | Symbol |
|---|---|---|
| source-archived-run-parameters | `scripts/compare_de_bv_mode_profiles.py` | `validate_record_parameters` |


## Niezależna zbieżność przez grubość filmu DE/BV

Poziomy L0–L3 przykładu DE-SMOKE sterują rozmiarem elementów w metrach,
lecz same nie dowodzą zbieżności przez grubość: domyślne `layers=3`
pozostaje stałe. Kontrolowany parametr `FULLMAG_DE_SMOKE_THICKNESS_LAYERS`
przyjmuje wyłącznie tekst `3`, `6` lub `9`; domyślnie `3`. Jest bezwymiarową
liczbą elementów, nie zmianą fizycznej grubości filmu (10 nm).
Python `body.mesh.thin_film(layers=...)` obniża żądanie do
`problem_meta.runtime_metadata.mesh_workflow.per_geometry[0].through_thickness_elements`.
Wrapper wymaga wersjonowanego samodzielnego wejścia i zgodności tej wartości
z `de_smoke.through_thickness_elements` oraz żądaniem runu. Ignorowanie
ustawienia oznacza błąd, a nie wykonany pomiar zbieżności.

Ta kontrola jest receptą walidacyjną FEM CPU, double, strict. Nie dodaje
realizacji FDM CPU/GPU ani nie dowodzi FEM GPU. Zachowuje pole bias, Ms,
A, gamma0, grubość, wektor k, dynamiczny demag i końcowy próg 1e-8.
Przesunięcie częstotliwości po zmianie warstw wymaga niezależnej kontroli
pól i źródeł oraz odrębnej zbieżności airboxu i kompletności widma.
Źródła: `examples/fem_de_smoke_numeric.py::THICKNESS_LAYERS`,
`scripts/run_de_100nm_pilot.py::validate_thickness_layers_metadata` oraz
`scripts/test_de_bv_25_model.py::test_thickness_convergence_preserves_physics`.


| Source ID | Path | Symbol |
|---|---|---|
| source-de-thickness-model | `examples/fem_de_smoke_numeric.py` | `THICKNESS_LAYERS` |
| source-de-thickness-wrapper | `scripts/run_de_100nm_pilot.py` | `validate_thickness_layers_metadata` |
| source-de-thickness-regression | `scripts/test_de_bv_25_model.py` | `test_thickness_convergence_preserves_physics` |


### Odbiór rzeczywistej rozdzielczości przez grubość

Sam zapis `through_thickness_elements` nie dowodzi realizacji. Pomiar DE
L2 z żądaniem 6 zachował fingerprint siatki wariantu 3 i tę samą częstotliwość.
Wrapper dodatkowo odczytuje rzeczywiste węzły i Tet4 z execution plan.
Dla jednorodnego filmu w płaszczyźnie xy wymaga pokrycia pełnej grubości
oraz maksymalnej rozpiętości Tet4 w osi z nie większej niż grubość podzielona
przez żądanie (z tolerancją geometryczną 1e-6 grubości). To dolna kontrola
rozdzielczości unstructured Tet4, nie certyfikat dokładnej liczby płaskich
warstw. Deklaracja i wykonana siatka są raportowane oddzielnie.
Obecna ścieżka free-tet dla Box nie realizuje dokładnej ekstruzji warstw;
nie wolno interpretować samego metadata jako wykonanego badania warstw.


## Realizacja warstw Box w periodycznym airboxie

Dla jednego osiowego Box, tetraedrów P1, stałego rozkładu warstw
i airboxu bbox o identycznych granicach bocznych generator GEO realizuje
każdą z żądanych warstw filmu jako osobny przedział ekstruzji.
Nie zastępuje żądania warstw swobodną tetraedryzacją.
`MeshOptions.through_thickness_elements` pozostaje kanonicznym wejściem
Python→ProblemIR→mesh workflow; nie zmienia materiału ani operatora demagu.
Obsługiwany kierunek to z, powierzchnia źródłowa jest trójkątna,
bez rekombinacji; niespełnione ograniczenia kończą się jawnym błędem.

Powietrze ma niezależne płaszczyzny. Rozmiar pierwszego kroku i skończony
limit kroku powietrza wyznacza równanie
{eq}`eq-box-airbox-step-size-resolution`. $h_{\mathrm{body}}$ jest bazowym rozmiarem
filmu przekazanym generatorowi, $h_{\min}^{\mathrm{air}}$ i $h_{\max}^{\mathrm{air}}$ to odpowiednio
jawne airbox minimum przy interfejsie i jawny far-air upper bound; długości
podano w metrach. $r$ jest bezwymiarowym `AirboxOptions.grading_ratio`
(domyślnie 1.3). Jeśli podano oba airbox rozmiary i
$h_{\min}^{\mathrm{air}}>h_{\max}^{\mathrm{air}}$, wejście zostaje odrzucone przed Gmsh. Jawny
$h_{\max}^{\mathrm{air}}$ nie jest podnoszony; przy braku jawnego minimum ogranicza też
domyślny pierwszy krok, gdy jest mniejszy od $h_{\mathrm{body}}$. Przy braku jawnego
maksimum skończony limit to $h_{\mathrm{in}}r^4$, czyli cztery geometryczne
zwiększenia przed nasyceniem. Ostatni krok domyka rzeczywistą granicę
airboxu.

| Symbol | Znaczenie | Jednostka |
|---|---|---|
| $h_{\mathrm{body}}$ | Bazowy rozmiar siatki filmu przekazany generatorowi | $\mathrm{m}$ |
| $h_{\min}^{\mathrm{air}}$ | Jawny rozmiar pierwszego kroku airboxu przy interfejsie | $\mathrm{m}$ |
| $h_{\max}^{\mathrm{air}}$ | Jawny górny limit rozmiaru w dalekim polu | $\mathrm{m}$ |
| $h_{\mathrm{in}}$ | Rozwiązany rozmiar pierwszego kroku airboxu | $\mathrm{m}$ |
| $h_{\mathrm{cap}}$ | Rozwiązany górny limit kroku airboxu | $\mathrm{m}$ |
| $r$ | AirboxOptions.grading_ratio (domyślnie 1.3) | $1$ |
| $\epsilon_z$ | Konserwatywna granica błędu domknięcia współrzędnych przy planowaniu płaszczyzn airboxu | $\mathrm{m}$ |
| $n$ | Liczba dotychczas zaplanowanych odcinków powietrza | $1$ |
| $z_0$ | Położenie płaszczyzny interfejsu body-air | $\mathrm{m}$ |
| $z_b$ | Położenie zewnętrznej granicy airboxu | $\mathrm{m}$ |
| $D_z$ | Długość przedziału od interfejsu do granicy | $\mathrm{m}$ |
| $S_z$ | Największa skala współrzędnej interfejsu, granicy i przedziału | $\mathrm{m}$ |
| $\operatorname{ulp}_{64}(S_z)$ | Lokalny odstęp binary64 między reprezentowalnymi współrzędnymi | $\mathrm{m}$ |
| $d$ | Skompensowany względny dystans od interfejsu | $\mathrm{m}$ |
| $h_{\mathrm{step}}$ | Bieżący rozmiar następnego kroku powietrza | $\mathrm{m}$ |
| $R_z$ | Skala względnego dystansu i kroku | $\mathrm{m}$ |
| $\operatorname{ulp}_{64}(R_z)$ | Lokalny odstęp binary64 na skali względnego planu | $\mathrm{m}$ |

```{math}
:label: eq-box-airbox-step-size-resolution

h_{\mathrm{in}} =
\begin{cases}
h_{\min}^{\mathrm{air}}, & \text{gdy jawne minimum powietrza podano},\\
\min(h_{\mathrm{body}},h_{\max}^{\mathrm{air}}),
    & \text{gdy minimum pominięto, a jawne maksimum podano},\\
h_{\mathrm{body}}, & \text{gdy pominięto oba rozmiary},
\end{cases}
\qquad
h_{\mathrm{cap}} =
\begin{cases}
h_{\max}^{\mathrm{air}}, & \text{gdy jawne maksimum podano},\\
h_{\mathrm{in}}r^4, & \text{gdy jawne maksimum pominięto}.
\end{cases}
```

Wszystkie długości w równaniu są w metrach SI; $r$ jest bezwymiarowe.
Nieskończony, niefinitywny lub niedodatni rozwiązany limit jest odrzucany
przed wywołaniem Gmsh.
Wszystkie wielkości wejściowe są w metrach; skalowanie GEO do mikrometrów
nie zmienia wyniku ani translacji Floqueta w artefaktach SI.

Planner sumuje względne długości z kompensacją Kahana, a każdą płaszczyznę
absolutną oblicza jako $z_0\pm d$. Nie akumuluje błędu początku układu przez
wszystkie odcinki. Niech $D_z=|z_b-z_0|$,
$S_z=\max(|z_0|,|z_b|,D_z)$,
$R_z=\max(D_z,|d|,h_{\mathrm{step}})$ i $n$ będzie liczbą dotychczas
zaplanowanych odcinków. Dwa lokalne ULP na skali absolutnej ograniczają
konwersję płaszczyzny; względna część obejmuje błędy arytmetyki sumowania
i obliczenia pozostałego odstępu:

```{math}
:label: eq-box-airbox-coordinate-closure

\epsilon_z =
2\operatorname{ulp}_{64}(S_z)
+4(n+2)\operatorname{ulp}_{64}(R_z).
```

$\epsilon_z$, $z_0$, $z_b$, $D_z$, $S_z$, $d$, $h_{\mathrm{step}}$, $R_z$,
$\operatorname{ulp}_{64}(S_z)$ i $\operatorname{ulp}_{64}(R_z)$ mają
jednostkę $\mathrm{m}$; $n$ jest bezwymiarowe. Duże przesunięcie początku
układu pozostaje dozwolone, gdy lokalny ULP współrzędnych jest mniejszy od
$h_{\mathrm{in}}$; nie zwiększa tolerancji proporcjonalnie do liczby odcinków.
Jeśli pozostały odstęp jest nie większy niż $\epsilon_z$, planner zastępuje
ostatnią zaplanowaną płaszczyznę
dokładną granicą tylko wtedy, gdy wydłużony w ten sposób poprzedni odcinek
nie przekracza $h_{\mathrm{cap}}+\epsilon_z$. W przeciwnym razie planner
odrzuca wejście przed Gmsh, zamiast emitować podrozdzielczy końcowy
odcinek. Każda długość odcinka jest więc ograniczona przez $h_{\mathrm{cap}}$
z dokładnością tej granicy zaokrągleń. Gdy lokalny ULP osiąga rozmiar
pierwszego kroku, planner zgłasza brak rozdzielczości współrzędnych zamiast
łączyć elementy o nierozróżnialnych płaszczyznach.

Ścieżka pierścienia zachowuje dotychczasowy podział geometrii; wspólna
reguła rozmiarów i stopniowania w osi z dotyczy zarówno Box, jak i
Box minus Cylinder. FDM CPU/GPU nie korzystają z tej siatki. Generacja FEM jest
wspólna, lecz solver FEM CPU wymaga odrębnego managed run, a FEM GPU
pozostaje NOT VERIFIED. Test planu płaszczyzn nie stanowi dowodu fizyki.
Bramki: dokładna liczba płaszczyzn magnetycznych, maksymalny pionowy
span Tet4, zgodne węzły periodyczne, dodatnie objętości, grupy body/air,
zachowanie granicy potencjału, niezależny residual Poissona oraz pilot DE/BV.
Mapa implementacji: `_box_airbox_layer_levels`,
`generate_swept_tetrahedral_box_airbox_mesh`,
`_generate_coincident_ring_airbox_mesh` w
`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`; wybór wspólnej
ścieżki: `asset_pipeline.py::_realize_fem_domain_mesh_asset_from_components_impl`.

Indeks źródeł realizacji warstw:

| ID | Plik | Symbol |
|---|---|---|
| source-box-layer-planes | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_box_airbox_layer_levels` |
| source-box-layer-roundoff-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_box_airbox_layer_plan_closes_roundoff_sized_final_slab` |
| source-box-layer-offset-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_box_airbox_layer_plan_allows_resolvable_offset_coordinates` |
| source-box-airbox-step-sizes | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_resolve_box_airbox_layer_sizes` |
| source-box-layer-generator | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_tetrahedral_box_airbox_mesh` |
| source-box-layer-routing | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_realize_fem_domain_mesh_asset_from_components_impl` |
| source-box-layer-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_public_de_model_shared_domain_realizes_six_layers` |
| source-box-airbox-sizing-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_public_box_default_airbox_cap_realizes_geometric_vertical_growth` |
| source-box-airbox-cap-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_public_box_explicit_airbox_cap_below_body_hmax_is_preserved` |
| source-box-airbox-explicit-minimum-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_public_box_explicit_airbox_minimum_above_body_hmax_is_preserved` |
| source-box-airbox-ring-default-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_ring_air_default_cap_realizes_geometric_vertical_resolution` |

Kontrola szwów obejmuje także boczne powierzchnie pierwszej i ostatniej
warstwy powietrza. Powierzchnia boczna dotykająca granicy z nie jest
płaszczyzną zewnętrznego Dirichleta: wymaga zgodności obu granic z
z jedną płaszczyzną. Ta korekta obejmuje wspólny generator Box i pierścienia.


## Raport metody warstwowej i ograniczenie stopniowania

`mesh_build_report.py::_build_mesh_operation_statuses` raportuje
`geo_layered_tetrahedral` dla `single_geometry_geo_layered_box`,
a nie historyczne `feature_aware_tetrahedral`. Kierunek realizacji to z.
Ocena liczby warstw na podstawie bocznego hmax nie jest kryterium
pionowej rozdzielczości tej ekstruzji; nadal wymagany jest pomiar elementów.
Ograniczenie nowej ścieżki: `AirboxOptions.grading_mode` musi być
`geometric` (wartość domyślna). Żądanie `linear` daje jawny błąd przed
Gmsh zamiast wykonania innej metody. Jest to niezakończony zakres
obsługi alternatywnego stopniowania, nie dowód jego realizacji.

| ID | Plik | Symbol |
|---|---|---|
| source-box-layer-report | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_mesh_operation_statuses` |


## Zachowanie źródłowego zagęszczenia filmu

Generator `_generate_coincident_ring_airbox_mesh` zachowuje zadany
rozmiar powierzchni źródłowej także po dołączeniu pól powietrza.
Wariant Box bez lokalnych pól ma jawne pole Constant ograniczone
do powierzchni źródłowej i jej brzegu. To pole pozostaje w końcowej
kombinacji rozmiarów: powietrze nie nadpisuje bocznego hmax filmu.
Hmax to cel charakterystycznego rozmiaru Gmsh, a nie ścisły limit
długości każdej krawędzi tetraedru.
Końcowy cap charakteryzuje również dalekie powietrze i może być większy
niż cel filmu. Dlatego dokładna warstwowa realizacja dodaje osobne górne
pole ograniczone do objętości magnetycznych. Jego `VIn` respektuje
rozwiązany per-owner `hmax` z `effective_per_object_targets` oraz jawne
owner-wide `ComponentVolumeConstant` pola. Te pola pozostają w istniejącym
upper `Min` stacku; body cap jest co najmniej tak duży jak ich `VIn`, więc
nie clampuje manualnego owner targetu. Pola regionalne nie podnoszą tego
globalnego body capu i pozostają w swoich dotychczasowych zakresach.
`VOut` jest neutralnym globalnym capem
`max(h_{\mathrm{body}}, h_{\mathrm{air}})`. Pole airboxu pozostaje
ograniczone do objętości powietrza, więc większy cel dalekiego powietrza
nie zmienia bocznej siatki filmu. Oba pola są składane operatorem minimum;
granica body–air otrzymuje ciaśniejszy z sąsiadujących celów. To zachowuje
rozdzielczość geometryczną filmu bez przenoszenia jego lower boundów do
zewnętrznego powietrza.
Dokładne zakresy pól upper w route warstwowym są następujące:

```{math}
:label: eq-swept-body-air-volume-upper-cap

h_{\mathrm{body}} = \max\!\left(h_{\mathrm{owner}},
  \max\!\left(\{0\}\cup\{VIn_f:f\in\mathcal{F}_{\mathrm{owner}}\}\right)\right),
\qquad
h_{\mathrm{global}} = \max(h_{\mathrm{body}}, h_{\mathrm{air}}),
\qquad
h_{\mathrm{body}}^{u}(\mathbf{x}) =
\begin{cases}
  h_{\mathrm{body}}, & \mathbf{x}\in\Omega_{\mathrm{body}},\\
  h_{\mathrm{global}}, & \mathbf{x}\notin\Omega_{\mathrm{body}},
\end{cases}
\qquad
h_{\mathrm{air}}^{u}(\mathbf{x}) =
\begin{cases}
  h_{\mathrm{airbox}}(\mathbf{x}), & \mathbf{x}\in\Omega_{\mathrm{air}},\\
  h_{\mathrm{global}}, & \mathbf{x}\notin\Omega_{\mathrm{air}},
\end{cases}
\qquad
h_{u}(\mathbf{x}) = \min(h_{\mathrm{body}}^{u}(\mathbf{x}),
                           h_{\mathrm{air}}^{u}(\mathbf{x})).
```

Wartości pól i ich dziedziny są przeskalowane do jednostek Gmsh po
zdefiniowaniu ich w SI; neutralny `VOut` nie przekracza globalnego capu.
Na powierzchni wspólnej pola nadal ogranicza ciaśniejszy target. Dodatkowe
upper fields są dalej składane przez `min`, a owner-scoped lower fields przez
opisaną poniżej kompozycję; równanie nie przenosi targetu ani flooru filmu do
objętości powietrza.
W swept Box, ring i mieszanym shared-domain wariancie source-face,
którego powierzchnia jest częścią siatkowanego komponentu, komponentowy
lower bound współtworzy pole tej powierzchni przed `mesh.generate(2)`:
późniejsze pole 3D nie może usunąć już wygenerowanych drobnych krawędzi
z ekstruzji. Dla każdej pozycji powierzchni źródłowej skala docelowa
jest kompozycją istniejących pól górnych i dolnych:

```{math}
:label: eq-swept-source-face-lower-bound-composition

h_{\mathrm{source}}(\mathbf{x}) =
\max\!\left(
  \min\!\left(h_{\mathrm{base}}(\mathbf{x}),
             h_{\mathrm{interface}}(\mathbf{x}),
             h_{\mathrm{component}}(\mathbf{x})\right),
  \max\!\left(h_{\mathrm{volume\ floor}}(\mathbf{x}),
               h_{\mathrm{region\ floor}}(\mathbf{x})\right)
\right).
```

Rozmiary w równaniu są w metrach SI. Bazowy upper target jest zawsze
obecny; pominięte dodatkowe upper fields są neutralne dla `min`, a brak
floor-ów oznacza zero dla dolnego pola. Komponentowy floor jest
ograniczony do powierzchni źródłowej jego właściciela i nadal jest
nakładany na odpowiadającą mu objętość po ekstruzji. Powierzchnia
zewnętrznego airboxu nie staje się właścicielem komponentowego floor-u;
na takim route floor pozostaje ograniczony do objętości komponentu.
Nie ustawia rozmiaru w airboxie ani nie zmienia górnych celów; lokalne
pole interfejsu i komponentu pozostają w tej samej kompozycji przed
generacją siatki 2D. Równanie
opisuje cel charakterystycznego rozmiaru Gmsh, nie dolny limit każdej
zrealizowanej krawędzi; ograniczenia geometrii mogą tworzyć krótsze
krawędzie. To zachowanie dotyczy generatora siatki, nie zmienia równania
FEM ani kwalifikacji fizycznej.

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $h_{\mathrm{source}}(\mathbf{x})$ | Docelowy charakterystyczny rozmiar na swept source-face po kompozycji pól | $\mathrm{m}$ |
| $h_{\mathrm{base}}(\mathbf{x})$ | Bazowy upper target źródłowej powierzchni | $\mathrm{m}$ |
| $h_{\mathrm{interface}}(\mathbf{x})$ | Upper target pola interfejsu na źródłowej powierzchni | $\mathrm{m}$ |
| $h_{\mathrm{component}}(\mathbf{x})$ | Upper target komponentu lub lokalnego regionu na źródłowej powierzchni | $\mathrm{m}$ |
| $h_{\mathrm{volume\ floor}}(\mathbf{x})$ | Wartość floor komponentowej objętości przeniesiona na jej źródłową powierzchnię | $\mathrm{m}$ |
| $h_{\mathrm{region\ floor}}(\mathbf{x})$ | Wartość floor regionu ograniczona jego kształtem i źródłową powierzchnią właściciela | $\mathrm{m}$ |
| $h_{\mathrm{global}}$ | Wspólny globalny cap Gmsh: większy z body `hmax` i zewnętrznego airbox maximum | $\mathrm{m}$ |
| $h_{\mathrm{body}}$ | Body-volume upper cap uwzględniający resolved target i owner-wide upper field program | $\mathrm{m}$ |
| $h_{\mathrm{owner}}$ | Rozwiązany per-owner `hmax` przed zastosowaniem jawnych pól owner-wide | $\mathrm{m}$ |
| $\mathcal{F}_{\mathrm{owner}}$ | Zbiór owner-wide `ComponentVolumeConstant` upper fields dla filmu; bez pól regionalnych | $1$ |
| $VIn_f$ | Jawny target `VIn` owner-wide pola $f$ | $\mathrm{m}$ |
| $h_{\mathrm{air}}$ | Maksymalny target zewnętrznego airboxu po rozwiązaniu warstw | $\mathrm{m}$ |
| $h_{\mathrm{airbox}}(\mathbf{x})$ | Ograniczony do airboxu profil upper targetów przestrzennych | $\mathrm{m}$ |
| $h_{\mathrm{body}}^{u}(\mathbf{x})$ | Pole body-volume upper z neutralnym wyjściem poza filmem | $\mathrm{m}$ |
| $h_{\mathrm{air}}^{u}(\mathbf{x})$ | Pole airbox upper z neutralnym wyjściem poza powietrzem | $\mathrm{m}$ |
| $h_u(\mathbf{x})$ | Minimum body- i airbox-volume upper fields przed dodatkowymi polami | $\mathrm{m}$ |
| $\Omega_{\mathrm{body}}$ | Magnetyczna objętość warstwowego filmu | $\mathrm{m}^3$ |
| $\Omega_{\mathrm{air}}$ | Objętość powietrza w dokładnym airboxie | $\mathrm{m}^3$ |

Sprawdzamy monotoniczne zagęszczenie x/y przy zmniejszaniu hmax,
stałą siatkę x/y przy zmianie liczby warstw, zgodność translacji SI
i fazy exp(-i k·r), dodatnie objętości oraz objętość filmu i airboxu.
Eksperyment z Mesh.MeshOnlyEmpty, opisanym w
[Gmsh 4.15.2](https://gmsh.info/doc/texinfo/#Mesh-options), odrzucono:
wielostopniowa ekstruzja wymaga ponownego zbudowania zgodnych siatek
powierzchni potomnych; zachowanie starej siatki dawało brak węzłów
ekstrudowanych. Nie jest to część implementacji.
Regresja generacji nie dowodzi zgodności częstotliwości eigensolve.

| ID | Plik | Symbol |
|---|---|---|
| source-box-layer-source-face | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_generate_coincident_ring_airbox_mesh` |
| source-box-body-volume-upper-cap | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_generate_coincident_ring_airbox_mesh` |
| source-box-resolved-owner-hmax-selection | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_realize_fem_domain_mesh_asset_from_components_impl` |
| source-box-owner-volume-field-upper | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_add_component_volume_constant_field` |
| source-box-owner-hmax-resolver | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets` |
| source-swept-source-face-lower-bound | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_apply_mixed_source_face_mesh_options` |
| source-swept-exact-ring-owner-floor | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_generate_coincident_ring_airbox_mesh` |
| source-swept-exact-ring-route-selection | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_realize_fem_domain_mesh_asset_from_components_impl` |
| source-swept-exact-ring-layer-report | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_mesh_operation_statuses` |
| source-swept-source-face-lower-bound-regression | `packages/fullmag-py/tests/test_meshing.py` | `test_swept_source_face_lower_bounds_compose_before_generation` |
| source-swept-exact-ring-floor-report-regression | `packages/fullmag-py/tests/test_meshing.py` | `test_scoped_exact_ring_lower_bound_uses_layer_route_and_report` |
| source-box-lateral-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_box_lateral_resolution_survives_final_air_fields` |
| source-box-air-profile-default-cap-body-xy | `scripts/test_box_layered_airbox_mesh.py` | `test_public_box_default_airbox_cap_realizes_geometric_vertical_growth` |
| source-box-air-profile-explicit-minimum-body-xy | `scripts/test_box_layered_airbox_mesh.py` | `test_public_box_explicit_airbox_minimum_above_body_hmax_is_preserved` |
| source-box-owner-hmax-air-profile-regression | `packages/fullmag-py/tests/test_meshing.py` | `test_exact_layer_body_target_precedence_survives_air_and_local_fields` |


## Warstwy powietrza w periodycznej komórce antidot A1

Ekstruzja wspólnej domeny Box minus Cylinder musi realizować stopniowanie
powietrza w osi z przez jawne płaszczyzny, tak samo jak pełny film Box.
Samo pole rozmiaru Gmsh nie dzieli ekstruzji z jednym elementem na odcinek.
Pierwszy krok ma rozmiar jawnego minimum powietrza, jeśli je podano; w
przeciwnym razie używa bazowego `hmax` filmu, ograniczonego do jawnego
airbox maksimum, jeżeli nie podano minimum. Przy braku jawnego maksimum
warstwy rosną do skończonego limitu z równania
{eq}`eq-box-airbox-step-size-resolution`; jawne maximum pozostaje
górnym ograniczeniem. Ostatni krok kończy się dokładnie
na zewnętrznej granicy Dirichleta. Film zachowuje n jednakowych warstw.
Zmiana n nie zmienia płaszczyzn zewnętrznego powietrza.
Jednostką długości w publicznym Python i IR jest metr; GEO używa skali 1e6,
a eksport przywraca SI. Translacje PBC x/y obejmują wszystkie warstwy.
Ta poprawka dotyczy generacji shared-domain dla FEM CPU/GPU, nie zmienia
równania Poissona ani fazy exp(-i k dot r). Alternatywne stopniowanie linear
w tej ścieżce nadal wymaga osobnej realizacji i nie może być wykonane jako
geometric. Test rzeczywistej siatki kontroluje pionowy span powietrza,
płaszczyzny, objętość komórki, dodatnie objętości elementów i pełne szwy.
Jest to dowód generacji; częstotliwości A1, zbieżność airboxu i porównanie
z COMSOL pozostają NOT VERIFIED do odbioru nowych managed artefaktów.

| ID | Plik | Symbol |
|---|---|---|
| source-ring-air-layer-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_ring_air_realizes_graded_vertical_resolution` |


## Niezalezna rozdzielczosc boczna komorki A1

W exact-cell ring charakterystyczny rozmiar powierzchni zrodlowej wynosi
hmax, tak jak dla Box. Historyczne min(hmax,2*t/n) uzaleznialo x/y od n
warstw filmu, przez co roznicy czestotliwosci nie mozna bylo przypisac samej
rozdzielczosci z. Ekstruzja Tet4 dopuszcza anizotropowe elementy; ten limit
nie jest warunkiem realizacji n warstw. Usuwamy go tylko ze wspolnego
exact-cell generatora. Inne historyczne sciezki meshera wymagaja osobnej
walidacji. Pola lokalne nadal zachowuja swoje jawne rozmiary.
Test porownuje rzeczywiste zbiory pozycji x/y dla n=1 i n=3 przy stalym
hmax oraz wymaga wiekszej liczby pozycji po zmniejszeniu hmax. Badanie
jakosci i zbieznosci widma na nowej siatce pozostaje odrebna bramka runtime.

| ID | Plik | Symbol |
|---|---|---|
| source-ring-lateral-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_ring_lateral_resolution_is_independent_of_film_layers` |


## Odbior porownania warstw DE/BV

Porownanie szesciu pilotow musi odczytywac t, Ms, A, gamma i pole z ich
metadata.json oraz orientacje M0=x,k=y (DE) albo M0=x,k=x (BV).
Referencja Kalinikos-Slavin n=0 jest przyblizeniem otwartego filmu;
nie stanowi dokladnego rozwiazania pelnego widma w skonczonym airboxie.
Nie wolno zastepowac odrzuconych modow wartosciami analitycznymi.
Kolektor wymaga zgodnych tozsamosci request/result/job/model, terminalnego
completed_unqualified, pelnych certyfikatow residualu <=1e-8, weryfikacji
rzeczywistych warstw, CSV/native spectrum i topologii fizycznego modu.
Wykorzystuje istniejaca mase P1 do diagnostyki profilu jednorodnego.
Dla zestawu n=3/6/9 w obu geometriach kontroluje stale parametry, airbox,
hmax i rzeczywiste pozycje x/y. Wyjscie pozostaje NOT VERIFIED: zbieznosc
warstw i airboxu oraz pokrycie widma wymagaja osobnej oceny.

| ID | Plik | Symbol |
|---|---|---|
| source-thickness-collector | `scripts/collect_de_bv_thickness_comparison.py` | `collect_record` |
| source-thickness-collector-regression | `scripts/test_collect_de_bv_thickness_comparison.py` | `test_rejects_wrong_receipt_before_field_loading` |


## Wykres kontroli grubosci przy stalym k

Wykres szesciu pilotow pokazuje f(n_z) i 100*(f_FEM-f_n0)/f_n0 osobno
w DE i BV. Nie jest krzywa dyspersji f(k), poniewaz wszystkie punkty maja
jednakowy k=25 rad/um. Nie wykonuje ekstrapolacji ani dopasowania do analityki.
Rysowanie wymaga ponownego zgodnego odczytu rekordow przez kolektor;
nie przyjmuje zmienionych wartosci odniesienia, residualow i profili.
Podpis zachowuje NOT VERIFIED i ograniczenie otwartego filmu n=0.
Artefakty PNG/PDF otrzymuja receipt z hashami danych i producenta.
Test renderowania jest syntetyczna kontrola prezentacji, nie wynikiem FEM.

| ID | Plik | Symbol |
|---|---|---|
| source-thickness-plot | `scripts/plot_de_bv_thickness_comparison.py` | `validate_comparison` |
| source-thickness-plot-regression | `scripts/test_plot_de_bv_thickness_comparison.py` | `test_modified_record_is_rejected_before_plotting` |

## Porównanie pilota DE z parametrami rzeczywistego modelu

<!-- DOC-ANCHOR: de-pilot-metadata-analytic-comparison -->

Postprocessor `scripts/compare_de_100nm_pilot.py::load_comparison_input` nie
wyprowadza grubości filmu z nazwy pliku. Czyta grubość, parametry materiałowe,
pole zewnętrzne, przenikalność próżni i padding airboxu z metadanych danej próby.
Dodatnie, skończone parametry SI i jawna orientacja DE są obowiązkowe.
Zadeklarowane próbki wektora falowego muszą zgadzać się z indeksami CSV
oraz samplingiem requestu. Obsługiwane klucze DE pochodzą z kanonicznego
`validate_de_smoke_rows.py::SAMPLING`; klucze BV są odrzucane.

Referencja pozostaje istniejącym przybliżeniem jednorodnego modu n=0
`verify_fem_frequency_domain_eigen_artifacts.py::kalinikos_slab_n0_frequency_hz`.
Nie uwzględnia pełnego sprzężenia modów przez grubość filmu. Osobny kontrolny
punkt Gamma uwzględnia skończone granice Dirichleta airboxu; nie stanowi
rozwiązania całej dyspersji przy skończonym airboxie. Ta poprawka nie zmienia
Python DSL ani ProblemIR, równań solvera ani tolerancji akceptacji modów.

Receipt request/result musi wskazywać ten sam model, źródła i job oraz sukces
wrappera. Względny residual jest odczytywany z `spectrum.v3.json`, jeśli jest
dostępny, z zachowaniem jego scope; bez tego artefaktu nie jest wyprowadzany
z bezwzględnego pola CSV. Gałąź do tabeli porównania wybiera się jawnie.
Sam wykres wszystkich modów nie identyfikuje fizycznej gałęzi.

Narzędzie służy analizie artefaktów FEM CPU; nie implementuje realizacji
FEM GPU ani FDM CPU/GPU. Raport zawsze pozostaje `NOT VERIFIED`: wymagane są
osobne dowody profilu modu, pokrycia widma oraz zbieżności siatki i airboxu.
Testy `scripts/test_compare_de_100nm_pilot.py::ComparisonTests` sprawdzają
routing, metadane, mapowanie CSV, referencję i render; nie kwalifikują FEM.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-de-pilot-metadata-comparison | `scripts/compare_de_100nm_pilot.py::load_comparison_input` | Metadane SI i receipt; FEM CPU postprocessing, NOT VERIFIED |
| source-de-pilot-comparison-tests | `scripts/test_compare_de_100nm_pilot.py::test_supported_de_sampling_includes_k25_and_rejects_bv` | Regresja routingu DE, test źródeł |

### Kompletność widma i zakres residuali w raporcie DE

CSV i sąsiedni `spectrum.v3.json`, jeśli istnieje, muszą zawierać dokładnie
ten sam zbiór par indeksów próbki i modu. `read_modes` odrzuca również
mod obecny tylko w natywnym widmie; nie raportuje takiego eksportu jako
kompletnego. Częstotliwości połączonych rekordów muszą być zgodne.

Raport zachowuje liczbę rekordów i maksymalny względny residual osobno dla
każdego natywnego scope. Przy wielu zakresach podaje `mixed`; bez dostępnego
scope podaje `unavailable`. Łączne maksimum nie oznacza certyfikacji pełnego
układu. Próg akceptacji solvera i równania nie zostały zmienione.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-de-csv-native-coverage | `scripts/compare_de_100nm_pilot.py::read_modes` | Dokładna zgodność indeksów CSV/widma i zachowanie scope; postprocessing FEM CPU |
| source-de-csv-native-coverage-test | `scripts/test_compare_de_100nm_pilot.py::test_csv_cannot_omit_a_mode_present_in_native_spectrum` | Odrzucenie niepełnego eksportu, regression check |


## Niezależny oracle profilu przez grubość filmu — kontrakt diagnostyczny

Ten mały solver spektralny kontroluje przybliżenie jednorodnego profilu n=0.
Nie jest realizacją FEM ani zamiennikiem produkcyjnego demag-k. Rozpatruje
jednorodny film nieskończony w płaszczyźnie, równowagę +x, brak tłumienia,
anizotropii i DMI oraz swobodne warunki wymiany na obu powierzchniach.
Pole magnetostatyczne jest otwarte, bez skończonego airboxu. DE oznacza k_y,
BV oznacza k_x. Kierunek z jest normalny do filmu. Rozwinięcie w cosinusach
zachowuje oddziaływania między profilami; N=1 odtwarza istniejące P00.
Zbieżność N oraz kwadratury jest niezależna od zbieżności FEM.

### Równania i jednostki

Niech u=z/t w przedziale [0,1], a=|k|t oraz
c_n(u)=sqrt(2-delta_n0) cos(n*pi*u), z normą całki c_n c_m równą delta_nm.
Z rozwiązania otwartego równania Poissona wynikają macierze R i S:

```{math}
:label: eq-thickness-oracle-kernels
R_{nm}=\frac{a}{2}\int_0^1\!\int_0^1 c_n(u)c_m(v)e^{-a|u-v|}\,dv\,du,
\qquad
S_{nm}=\frac{a}{2}\int_0^1\!\int_0^1 c_n(u)c_m(v)\operatorname{sgn}(u-v)e^{-a|u-v|}\,dv\,du.
```

Całka wewnętrzna jest obliczana analitycznie; zewnętrzna kwadraturą Gaussa.
R jest symetryczna, S antysymetryczna. Dla a=0 przyjmuje się R=S=0.
W polach poprzecznych (m_y,m_z) operator demag ma postać:

```{math}
:label: eq-thickness-oracle-demag
\mathcal N_{\rm DE}=\begin{pmatrix}R&i\operatorname{sgn}(k)S\i\operatorname{sgn}(k)S&I-R\end{pmatrix},
\qquad
\mathcal N_{\rm BV}=\begin{pmatrix}0&0\0&I-R\end{pmatrix}.
```

Macierz energii w jednostkach indukcji i liniowy operator LL:

```{math}
:label: eq-thickness-oracle-discrete
D_{nn}=B_0+\frac{2A}{M_s}\left[k^2+\left(\frac{n\pi}{t}\right)^2\right],
\quad
K=\operatorname{diag}(D,D)+\mu_0M_s\mathcal N,
\quad
L=\frac{\gamma_0}{\mu_0}\begin{pmatrix}0&-I\I&0\end{pmatrix}K,
\quad
\lambda=i\omega,\quad f=\frac{\operatorname{Im}\lambda}{2\pi}.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $t$ | grubość filmu | $\mathrm m$ |
| $k$ | podpisana składowa wektora falowego | $\mathrm{rad\,m^{-1}}$ |
| $u$ | współrzędna grubości | $1$ |
| $v$ | współrzędna całkowania | $1$ |
| $a$ | iloczyn modułu k i grubości | $1$ |
| $c_n$ | ortonormalny profil cosinusowy | $1$ |
| $R$ | podłużny blok dipolowy | $1$ |
| $S$ | antysymetryczny blok mieszany | $1$ |
| $\mathcal N$ | tensor demag w bazie profili | $1$ |
| $I$ | macierz jednostkowa | $1$ |
| $N$ | liczba profili | $1$ |
| $n$ | indeks wiersza bazy | $1$ |
| $m$ | indeks kolumny bazy | $1$ |
| $\delta_{nm}$ | delta Kroneckera | $1$ |
| $\pi$ | stała pi | $1$ |
| $A$ | stała wymiany | $\mathrm{J\,m^{-1}}$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $B_0$ | pole równowagi | $\mathrm T$ |
| $D$ | diagonalny blok wymiany i pola | $\mathrm T$ |
| $K$ | macierz energii liniowej | $\mathrm T$ |
| $\mu_0$ | przenikalność próżni | $\mathrm{T\,m\,A^{-1}}$ |
| $\gamma_0$ | dodatnie gamma dla pól H | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $L$ | operator czasowy | $\mathrm{s^{-1}}$ |
| $\lambda$ | wartość własna | $\mathrm{s^{-1}}$ |
| $\omega$ | częstotliwość kątowa | $\mathrm{s^{-1}}$ |
| $f$ | częstotliwość dodatniej gałęzi | $\mathrm{Hz}$ |

W N=1 otrzymuje się R00=1-(1-exp(-a))/a oraz S00=0. Jest to bramka
zgodności z dotychczasowym P00, nie dowód dokładności P00 przy dowolnym kt.
Niezależne przedstawienie warunków brzegowych i ograniczeń przybliżenia
diagonalnego opisują Harms i Duine, arXiv:2109.10597; niniejsze całkowe
wyprowadzenie i implementacja są własnym oracle, nie kopią ich solvera.

### Parametry, granice i realizacje

Publiczne funkcje pomocniczego skryptu wymagają jawnych Ms, A, B0, t, gamma0,
k, konfiguracji DE/BV i N; brak domyślnych materiałów lub rozmiaru próbki.
Ms, B0, t, gamma0 muszą być skończone i dodatnie, A skończone i nieujemne,
k skończone. N jest dodatnią liczbą całkowitą do 64. Kwadratura ma jawny
parametr, domyślnie 128 punktów; dopuszczalny zakres 16–512 i co najmniej 2N.
Nieprawidłowe dane kończą się ValueError. Wartości bool nie są liczbami fizycznymi.
Obliczanie pełnego małego widma jest diagnostyką, nie produkcyjnym dense default.

Nie zmieniono Python DSL, ProblemIR, planera, capability, API ani workspace.

| Parametr helpera | Typ / domyślnie | SI / domena | Znaczenie |
|---|---|---|---|
| ms_a_m | float / wymagany | $\mathrm{A\,m^{-1}}$, dodatni finite | Ms |
| exchange_j_m | float / wymagany | $\mathrm{J\,m^{-1}}$, nieujemny finite | A |
| bias_t | float / wymagany | $\mathrm T$, dodatni finite | B0 |
| thickness_m | float / wymagany | $\mathrm m$, dodatni finite | t |
| gamma0_m_a_s | float / wymagany dla solve | $\mathrm{m\,A^{-1}\,s^{-1}}$, dodatni finite | gamma0 |
| k_rad_m | float / wymagany | $\mathrm{rad\,m^{-1}}$, finite | podpisane k |
| geometry | str / wymagany | DE lub BV | kierunek propagacji |
| basis_size | int / wymagany | 1..64, bez bool | N |
| quadrature_points | int / 128 | max(16,2N)..512, bez bool | kwadratura |

Skrypt nie przyjmuje authoringu zamiast kanonicznego study i nie obiecuje
obsługi nowych interakcji. Parametry porównania muszą pochodzić z rzeczywistego
metadata wejściowego; wynik oracle zapisuje je wraz z N i kwadraturą.
FDM CPU/GPU i FEM GPU: nie dotyczy, bez promocji ich wsparcia.
FEM CPU: oracle pomocniczy host NumPy, nie managed MFEM i nie dowód parytetu.
Nie dotyczy antidotu A1, materiałów niejednorodnych ani powierzchni z pinningiem.
Finite-airbox FEM przy k=0 ma odrębny model; nie wolno utożsamiać go z otwartym oracle.

### Bramki i źródła

Wymagane: N=1 vs P00 dla DE/BV i k=0, Hermitowskość demag, odwrócenie
k przy symetrycznym filmie, stabilność dodatniego widma, zbieżność N i kwadratury,
residual własnego operatora oracle. Residual oracle nie jest residualem FEM.
Porównanie do aktualnego #179 i zbieżność FEM nadal NOT VERIFIED.

- Harms, J. S.; Duine, R. A., *Theory of the dipole-exchange spin wave spectrum
  in ferromagnetic films with in-plane magnetization revisited*, 2021:
  https://arxiv.org/abs/2109.10597 (model LL/Maxwell i swobodne exchange BC).

| Source ID | Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|---|
| source-thickness-oracle-matrices | `scripts/thin_film_thickness_oracle.py` | `modal_matrices` | całkowy demag i baza wymiany |
| source-thickness-oracle-solve | `scripts/thin_film_thickness_oracle.py` | `solve_thickness_modes` | mały oracle LL, częstotliwości i residual własnego operatora |


(physical-potential-declared-mode-binding)=
## Powiązanie fizycznego potencjału z opublikowanym modem

Niezależna zgodność zapisanego pola z gradientem potencjału nie dowodzi,
że artefakt należy do badanego punktu i modu. Kontrola DE-SMOKE dodatkowo
wiąże manifest z `eigen/modes/sample_NNNN/mode_MMMM.json` po sample_index,
raw_mode_index oraz deklaracjach source_mesh_topology_sha256,
operator_input_signature_sha256 i phase_constraint_sha256. Wymaga zgodnych,
nieujemnych indeksów, poprawnych SHA-256, kanonicznych ścieżek wybranego modu
oraz jego sidecarów. Powtórzone klucze JSON i sprzeczne indeksy są błędem,
nie podstawą do wyboru ostatniej wartości.

W `validate_physical_potential` parametr pomocniczy `mode_metadata_path`
(default None) wybiera tę kontrolę: brak parametru zachowuje wyłącznie
kontrolę algebraiczną i raportuje identity_binding=not_requested. Trasa
`validate_smoke_potential_fields` przekazuje go obowiązkowo dla każdego
opublikowanego pola. CLI udostępnia równoważne `--mode-metadata`.
Nie zmienia to publicznego DSL, ProblemIR, operatorów ani równań mikromagnetycznych.
FEM CPU/GPU: ten sam odczyt artefaktów, bez dowodu wykonania urządzenia.
FDM CPU/GPU: nie dotyczy tego formatu potential Tet4.

Status identity_binding=consistent oznacza zgodne deklaracje producenta,
nie niezależne przeliczenie fingerprintu pełnej siatki, dowód równania Poissona,
zbieżności FEM ani normalizacji potencjału względem magnetyzacji. Kwalifikacja
raportu pozostaje NOT VERIFIED. Nowy walidator jest niezależnym postprocessing;
nie modyfikuje kapsuły ani receipt #182.

| Źródło | Owner | Kontrakt |
|---|---|---|
| scripts/validate_de_physical_potential.py | _validate_declared_mode_binding | Tożsamość deklaracji i ścieżek przed porównaniem gradientu |
| scripts/run_de_100nm_pilot.py | validate_smoke_potential_fields | Obowiązkowe związanie każdego opublikowanego modu |
| scripts/test_de_physical_potential.py | class PhysicalPotentialValidatorTests | Zmienione indeksy/hash, błędne typy i duplicate JSON |


(physical-potential-source-mesh-binding)=
## Przeliczenie tożsamości siatki rekonstrukcji

Opcjonalny parametr pomocniczy `verify_source_mesh=False` zachowuje dawną
kontrolę algebraiczną. Pilot DE-SMOKE wymaga `True`: oblicza fingerprint v3
z kanonicznych nodes/cells/facets, markerów i par periodycznych dokładnie
według `MeshData.topology_fingerprint_v3`, zamiast porównywać wyłącznie deklaracje.
Dane legacy bez kanonicznej topologii nie przechodzą tej bramki. CLI:
`--verify-source-mesh`. Raport source_mesh_binding wiąże również SHA-256
pliku metadata. Przeliczenie fingerprintu nie jest dowodem Poissona ani zbieżności.
Nie zmienia równań, jednostek, publicznego DSL ani ProblemIR.
FEM CPU/GPU: kontrola formatu artefaktów; bez dowodu wykonania urządzenia.
FDM CPU/GPU: nie dotyczy artefaktu Tet4. Kwalifikacja nadal NOT VERIFIED.

| Źródło | Owner | Kontrakt |
|---|---|---|
| scripts/validate_de_physical_potential.py | _validate_source_mesh_binding | Fingerprint kanonicznej topologii z metadata |
| packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py | topology_fingerprint_v3 | Istniejący kontrakt v3; bez kopii algorytmu |


(oracle-exchange-free-de-limit)=
## Kontrola dokładnej granicy magnetostatycznej DE

Dla jednorodnego, symetrycznego filmu otoczonego próżnią, magnetyzacji
w płaszczyźnie, $\mathbf{k}\perp\mathbf{m}_0$, zerowej wymiany $A=0$,
bez anizotropii i tłumienia, magnetostatyczna gałąź powierzchniowa spełnia:

```{math}
:label: eq-oracle-exchange-free-de-limit
f^2=\left(\frac{\gamma_0}{2\pi\mu_0}\right)^2
\left[B_0(B_0+\mu_0 M_s)+\frac{(\mu_0 M_s)^2}{4}
\left(1-e^{-2|k|t}\right)\right].
```

Symbole i jednostki $f$, $\gamma_0$, $\mu_0$, $B_0$, $M_s$, $k$, $t$
zdefiniowano w tabeli oracle powyżej. Wzór wynika z liniowego LL i
magnetostatycznych warunków otwartej powierzchni; źródło pierwotne:
Damon i Eshbach (1961), https://doi.org/10.1016/0022-3697(61)90041-5.
Dla $k=0$ redukuje się do Kittela, a dla dużego $|k|t$ do częstotliwości
pola $B_0+\mu_0M_s/2$. Obliczenie małego argumentu używa expm1.

Regresja porównuje najwyższą dodatnią częstotliwość oracle przy $A=0$
z tym niezależnym wzorem dla $|k|t=0.25,1,2$ i N=8/16/32.
W granicy bez wymiany jest to wydzielona gałąź powierzchniowa; nie wolno
wybierać tu najniższego modu ani przenosić tego wyboru na $A>0$.
Największy względny błąd przy N=32 wyniósł 1.5513451168125414e-7;
liczba funkcji i błąd truncation pozostają jawne. Osobny test Γ sprawdza
brak sztucznego rozszczepienia przy $A=0$.

Siedem lekkich testów oracle PASS. Raport, PNG i PDF:
scientific-batches/exchange-free-de-oracle-20260930. Nie zmienia to
solvera, kryterium residualu, DSL ani ProblemIR. FDM CPU/GPU i FEM GPU:
bez nowego dowodu wykonania; FEM CPU: referencja pomocnicza, nie managed FEM.
Kontrola nie kwalifikuje skończonego airboxu, Poissona ani produkcyjnego
benchmarku z niezerową wymianą. Status pozostaje diagnostic_oracle_only_not_FEM.

| Źródło | Owner | Kontrakt |
|---|---|---|
| scripts/test_thin_film_thickness_oracle.py | test_exchange_free_surface_branch_converges_to_exact_damon_eshbach | Niezależny wzór DE dla A=0 i zbieżność N |
| scripts/test_thin_film_thickness_oracle.py | test_exchange_free_gamma_limit_has_no_artificial_basis_splitting | Kittel w Γ, wszystkie mody bez wymiany |

| Źródło miary i znaku przekroju S09 | Stabilny symbol | Kontrakt i dowód |
|---|---|---|
| docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md | DOC-ANCHOR:waveguide-section-measure | Tożsamość miary 2D i całki 3D podzielonej przez długość; kontrakt planowany, runtime niezweryfikowany |
| docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md | DOC-ANCHOR:waveguide-weak-source-sign | Rozróżnienie dodatniego źródła słabego i ujemnego bloku descriptora |
| scripts/test_waveguide_axial_sign_source.py | extruded_weak_source | Niezależna kwadratura mieszanego źródła zespolonego; kontrola interpretowana, bez wykonania native |
| docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md | DOC-ANCHOR:floquet-airbox-source-convention | Konwencja raw RHS i descriptora dense bridge |
| backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp | assemble_floquet_airbox_dynamic_demag_k | Jawna jednorazowa konwersja źródła przed rekonstrukcją |
| backends/fem/tests/frequency_domain/floquet_airbox_operator_test.cpp | main | Regresja obu konwencji i fizycznego potencjału; przygotowana, niekompilowana |
| scripts/test_floquet_airbox_source_convention.py | test_physical_potential_requires_conversion_while_schur_is_invariant | Niezależna algebra potencjału i podłączenie źródłowe; bez native |
| backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp | assemble_floquet_waveguide_cross_section_blocks | Bloki i geometria przekroju niezależne od metadanej długości; źródła, bez nowego managed wykonania |
| backends/fem/tests/frequency_domain/floquet_waveguide_cross_section_test.cpp | main | Wywołuje regresje miary oraz mixed_source_matches_independent_weak_quadrature; przygotowane, niekompilowane |


(k0-window-krylov-oversampling-v2)=
## Większa przestrzeń Kryłowa pełnego okna K0 — hipoteza do kwalifikacji

Runtime234, serial15 na niezmiennym filmie DE, zakończył siedem podprzedziałów
z EPS iteration limit2000. Zaakceptowane original-descriptor residuals nie
zawiodły; pełny frequency-window certificate pozostaje failed. Dla bazowego
NEV4/NCV8 uzyskano dwie pary, dla części refined NEV8/NCV16 sześć par. To dowód
stagnacji EPS, ale nie dowód jej przyczyny. Większa przestrzeń jest pojedynczą
zmianą do sprawdzenia, bez osłabienia residualu lub kompletności okna.

```{math}
:label: eq-k0-window-krylov-oversampling-v2
n_{\mathrm{cv}}=\min\!\left(D,\max(n_{\mathrm{ev}}+1,
\chi n_{\mathrm{ev}})\right),\qquad
\chi=\begin{cases}4&\text{pełne okno częstotliwości},\\
2&\text{pojedynczy shift poza oknem}.\end{cases}
```

$D$ oznacza wymiar real-split operatora; $n_{\mathrm{ev}}$ liczbę żądanych Ritz
pairs, $n_{\mathrm{cv}}$ rozmiar przestrzeni Kryłowa, a $\chi$ mnożnik
nadpróbkowania. Wszystkie cztery mają jednostkę $1$. Nadal wymagane jest
$0<n_{\mathrm{ev}}<D$; implementacja ogranicza mnożenie przed wykonaniem, także
przy granicy u64. Dla tego runu bazowe NCV zmienia się8→16 i refined16→32,
bez zmiany NEV. MPD pozostaje wyborem SLEPc; provenance zapisuje actual queried
NEV/NCV/MPD, zamiast przypisywać bibliotece niezmierzoną wartość.

Owner: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
+ `bounded_krylov_dimensions`; window coordinator i borrowed subcalls muszą
wybierać tę samą politykę. Certificate publikuje
`bounded_quadruple_nev_window_v2`. Historyczne v1 wyniki pozostają niezmienione.
Standalone nearest nadal używa dotychczasowej polityki. Równania magnetyczne,
demag/Poisson, SI, siatka, preconditioner cap, EPS/KSP tolerancje, restart8,
schedule50, residual acceptance i cały window certificate nie zmieniają się.
Zwiększenie NCV zwiększa pamięć oraz koszt ortogonalizacji; nie gwarantuje
zbieżności ani krótszego runtime.

FEM CPU: implementacja źródłowa do managed kwalifikacji. FEM GPU: ten owner CPU
nie zmienia ani nie dowodzi ścieżki GPU. FDM CPU/GPU: nie dotyczy. Publiczny Python,
ProblemIR, planner legality, OpenAPI i eksport skryptu UI zachowują kontrakt;
zmienia się wewnętrzna polityka Kryłowa i jej istniejąca diagnostyka.

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $D$ | Wymiar operatora real-split | $1$ |
| $n_{\mathrm{ev}}$ | Żądana liczba par Ritz | $1$ |
| $n_{\mathrm{cv}}$ | Wymiar przestrzeni Kryłowa | $1$ |
| $\chi$ | Mnożnik nadpróbkowania | $1$ |

Dokumentacja [SLEPc EPSSetDimensions](https://slepc.upv.es/release/manualpages/EPS/EPSSetDimensions.html)
rozdziela NEV, NCV i MPD oraz zaleca jawny wybór co najwyżej jednego z NCV/MPD.
Polityka4 jest lokalną hipotezą Fullmaga do walidacji; nie jest gwarancją SLEPc.

Wymagana walidacja: ten sam frozen Γ/model/okno/NEV i solver controls, zmienione
wyłącznie window NCV; pełne50/50, EPS/KSP diagnostics, dotychczasowy certificate,
original-descriptor residuals i zgodny wybrany mod. Native regression ma
sprawdzić bounded wymiary w każdym subwindow oraz standalone nearest bez zmiany.
Kompilacja unit tests wyłącznie CI; lokalny managed runtime-v2 nie kompiluje
unit tests. Dopóki pełny runtime nie przejdzie, poprawka pozostaje NOT VERIFIED.


### Kontrola rzeczywiście użytej przestrzeni w próbie Γ

Prywatny postprocessor `validate_gamma_krylov_trial` ma opcjonalne
`expected_window_krylov_policy`. Brak zachowuje historyczny kontrakt query-only;
żądanie v2 wymaga exact policy label i skutecznego odczytu actual EPS dimensions
w każdym podoknie, zgodnych z jego requested NEV/NCV i bounded polityką4.
MPD musi być dodatnie i mieścić się w rzeczywistej przestrzeni. Sam SHA buildu
ani nowy label nie zastępują tych pomiarów. Raport nadal ma NOT VERIFIED i
nie dowodzi residualu, pełnego frequency-window certificate ani fizyki.

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/de_gamma_krylov_trial.py | _validate_window_basis_policy | Związanie actual queried EPS dimensions z deklaracją konkretnego podokna |
| scripts/test_de_gamma_krylov_trial.py | class GammaWindowBasisPolicyTests | Odrzucenie starej, błędnie opisanej lub niezmierzonej przestrzeni; wykonanie wyłącznie CI |


### Żądanie polityki w zarządzanym pilocie Γ

`run_de_100nm_pilot.py --expected-window-krylov-policy` ma typ enum string,
domyślnie brak, jednostkę $1$ i wartości `bounded_double_nev_v1` lub
`bounded_quadruple_nev_window_v2`. Wymaga próbki Γ oraz jawnego shifted KSP type.
Wspólny preflight obowiązuje CLI i programmatic execute przed dispatch.
Opcja trafia wyłącznie do postsolve report/guard; nie zmienia ProblemIR,
compose_command ani konfiguracji operatora. Żądanie bez Γ jest błędem,
a nie pomijaną opcją. Dry-run ujawnia żądaną politykę; kwalifikacja pozostaje
odrębna od dowodu rzeczywiście użytych dimensions.

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/run_de_100nm_pilot.py | _validate_window_policy_request | Wspólny preflight polityki/KSP/Γ przed jakimkolwiek dispatch |
| scripts/run_de_100nm_pilot.py | _validate_krylov_trials | Przekazanie żądanej polityki do postsolve proof, bez zmiany native inputs |
| scripts/test_de_gamma_krylov_trial.py | class GammaWindowPolicyPilotRoutingTests | Forwarding oraz odrzucenie ignored-policy przed execute dispatch |


### PETSc real-split pencil: structural zero diagonal

`backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` +
`create_real_frequency_rotated_pencil` must retain an explicit diagonal slot
for every row of each rotated AIJ matrix. Compact physical CSR operators can
have only off-diagonal entries; realification can also move the generalized
mass into off-diagonal blocks. An absent slot prevents PETSc SeqAIJ symbolic
LU even when the shifted operator is numerically invertible. Adding an exact
zero with the same `ADD_VALUES` assembly mode preserves the operator and its
existing nonzero diagonal values; it is not regularization, a changed shift,
or an epsilon perturbation. Hard assembly errors retain the existing graph
quarantine boundary. The public MFEM compact-CSR fixture
`modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator` keeps
its off-diagonal input and must pass through the actual SLEPc provider.
GHA37859465446 reproduced the missing-slot failure before this correction;
execution after correction is **NOT VERIFIED**.


### PCLU nonzero-diagonal permutation before shift-invert

`backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` +
`SLEPcTinyGyrotropicModalEigenResult solve_slepc_gyrotropic_modal_eigen_attempt` configures PCLU for the rotated
pencil. Structural diagonal slots do not imply numerically nonzero pivots.
For an invertible off-diagonal pencil, pivoting through very small diagonal
shifts can lose precision. GHA37866131831 found the expected $0.159\,\mathrm{Hz}$ candidates
but rejected dimensionless EPS relative residuals around $7.8\times10^{-6}$
and $4.8\times10^{-6}$, before physical vector reconstruction, against the
unchanged $10^{-12}$ gate. The observed cause
requires verification; the log does not measure actual LU pivots.

The bounded correction to test is checked
`PCFactorReorderForNonzeroDiagonal(pc, PETSC_DECIDE)` before EPS setup, retaining
the current shift policy. PETSc3.24.6 selects its ordering threshold; that
threshold chooses a permutation and is not an eigenpair, KSP, or physical
residual tolerance. The permutation changes neither operator values nor the
physical metric. API errors follow the existing graph quarantine and do not
permit later PETSc queries. No dense fallback or dependency change is allowed.
[Versioned PETSc PCLU implementation](https://raw.githubusercontent.com/petsc/petsc/v3.24.6/src/ksp/pc/impls/factor/lu/lu.c)
provides the upstream behavior. GHA37870357673 at
`95d1fcccd4df222f5d3c0c6445ad2b6eedb25e8b` reached the successful actual MFEM
compact-CSR frequency-window and nearest assertions with the original gates;
the suite then failed in a separate missing-CSR negative fixture whose expected
reason was inconsistent with the upfront structural validation. This is narrow
positive-provider evidence, not a passing complete generic/refill contract.
Full post-correction provider regression remains **NOT VERIFIED**.


### Canonical Python output snapshots at ordered stage boundaries

Canonical rewrite must preserve each immutable `LoadedStage.problem.study`
output snapshot, including mode selectors, branch/sample restrictions and
spectrum scope. Rendering only the persistent TimeEvolution base loses Eigen
and FrequencyResponse selectors; unioning later snapshots into that base leaks
future output choices into earlier stages.

`packages/fullmag-py/src/fullmag/runtime/script_builder.py` +
`_sync_stage_output_snapshot` reconciles the families admitted by each study at
its boundary. It appends a missing suffix or clears/restores replaced selectors,
retaining other already-known families. The existing ordered autosave action
updates renderer state after its command; unknown output types remain explicit
errors. Public Python constructors, normalized ProblemIR and solver semantics
are unchanged. This concerns transport/authoring for all four execution lanes,
not proof of a numerical solve or CPU/GPU parity.

`packages/fullmag-py/tests/test_script_builder_roundtrip.py` +
`class ScriptBuilderEigenOutputRoundTripTests` compares the full per-stage
StudyIR for two Eigen stages, mixed Time/Eigen/Time, disable-all autosave and
FrequencyResponse/Eigen. The existing API selector regression remains an
independent gate. Source review and parsing passed; hosted execution of this
correction is **NOT VERIFIED**.


(count-physical-fixture-contract)=
### Physical source contract for the native count fixture

Status: source correction reviewed, hosted execution **NOT VERIFIED**. The original count fixture failed with an
empty term mask. The shared production importer assembles native magnetic Aqq
from the descriptor and replaces the supplied synthetic CSR; changing only the
mask would not establish physical consistency.

The bounded CPU fixture uses the same expanded conforming mesh, periodic
partition and geometric tangent mass, uniform magnetization along z, zero
Gilbert damping, $M_s=2\,\mathrm{A\,m^{-1}}$,
$\gamma_0=3\,\mathrm{m\,A^{-1}\,s^{-1}}$ and
$H_0=100\,\mathrm{A\,m^{-1}}$. These are explicit test-model parameters, not
production defaults or a DE/BV dispersion benchmark.

| Token | Meaning | SI unit |
|---|---|---|
| $H_0$ | prescribed total effective bias of the count fixture | $\mathrm{A\,m^{-1}}$ |
| $\mathbf e_z$ | unit direction of the prescribed equilibrium | $1$ |
| $\mathbf H_{\rm ext}$ | compensating external field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{{\rm demag},0}$ | owner-computed static demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{{\rm eff},0}$ | total static effective field | $\mathrm{A\,m^{-1}}$ |
| $\phi_0$ | owner-computed static magnetic scalar potential | $\mathrm A$ |
| $\mathbf A_Z$ | Zeeman curvature in the geometric weak tangent basis | $\mathrm J$ |
| $\mathbf B$ | gyrotropic weak tangent block | $\mathrm{J\,s}$ |
| $\mathbf J$ | tangent-plane rotation matrix | $1$ |
| $\mathbf D$ | positive dynamic demag curvature in the same basis | $\mathrm J$ |
| $f_Z$ | independent local-field reference frequency | $\mathrm{Hz}$ |
| $f_j$ | frequency of physical mode j | $\mathrm{Hz}$ |
| $j$ | physical mode index | $1$ |

Static demag and $\phi_0$ must be computed by the native owner. Compensation
then makes the total field parallel to the prescribed magnetization:

```{math}
:label: eq-count-fixture-equilibrium
\mathbf H_{\rm ext}=H_0\mathbf e_z-\mathbf H_{{\rm demag},0},
\qquad \mathbf H_{{\rm eff},0}=H_0\mathbf e_z.
```

For this FIELD/DEMAG model, with the native tangent basis and zero damping,
the independent local-field oracle is:

```{math}
:label: eq-count-fixture-local-field
\mathbf A_Z=\mu_0 M_s H_0\mathbf M_T,
\qquad \mathbf B=\frac{\mu_0 M_s}{\gamma_0}\mathbf M_T\mathbf J,
\qquad f_Z=\frac{\gamma_0H_0}{2\pi}.
```

For a consistent positive Poisson bilinear form and its adjoint FE coupling,
the demag energy bound implies the following bracket. Its prerequisites and
inequality must be checked on the actual assembled blocks:

```{math}
:label: eq-count-fixture-demag-bound
0\preceq\mathbf D\preceq\mu_0M_s^2\mathbf M_T,
\qquad f_Z\le f_j\le\frac{\gamma_0(H_0+M_s)}{2\pi}.
```

The source-defined search window $[0.90f_Z,1.03f_Z]$ is derived before observing any
spectrum and has one partition with its midpoint below this bracket. Preserve
all residual and canonical-admission gates; best-effort mode cap and rejection
of unsupported certified-count policy remain distinct controls.

Required source evidence: `demag_poisson_solve.cpp` +
`context_compute_demag_poisson` for static H/phi; `poisson_airbox_shared_domain.cpp`
+ `assemble_native_magnetic_a_qq` and `assemble_poisson_airbox_shared_domain` for
native weak blocks; `canonical_digest.hpp` + `class CanonicalDigestBuilder` for
actual data/term bindings. Compare canonical equivalence partitions and the
actual static/dynamic boundary forms and gauges. Equal beta or class counts
alone are insufficient, especially when the static owner omits periodic
boundary traces. Do not introduce an arbitrary CSR, zero-potential assumption,
constant placeholder hashes, or a dense fallback. This gate exercises FEM CPU;
FEM GPU and both FDM lanes gain no qualification from it.


(dedup-quality-order-contract)=
### Residual-priority representatives for nontransitive overlap

Source correction of review #4226154713: GHA37881590033 native algebraic regression **PASS**. MFEM/SLEPc-provider and physical-dispersion qualification remain **NOT VERIFIED**.
The frequency-distance and geometric tangent-mass overlap thresholds stay
unchanged. Their conjunction is a pairwise duplicate predicate, not an
assumption of a transitive equivalence relation. Process candidates by increasing
finite residual, then frequency for residual ties, retaining stable input order
for exact ties. Accept a candidate only if it is not a duplicate of any accepted
representative. Never replace an accepted representative during this pass;
finally order the retained output by frequency. This preserves pairwise distinct
survivors and prioritizes residual quality without collapsing connected chains
of mutually nonduplicate endpoints. Exact residual/frequency ties retain the
existing input-order tie semantics, not a claim of permutation-invariant identity.

Comparison normalization remains internal: the strict mass-action path returns
original vectors, identities, amplitudes, frequencies and residuals. The legacy
dense comparison wrapper follows the same representative-selection policy;
its existing normalized-output behavior is unchanged. No residual-admission,
frequency-distance, overlap, mass-positivity, mode-count or solver-budget gate
is relaxed. Regression uses a nonuniform positive diagonal mass and three
vectors whose middle direction overlaps both endpoints above threshold, while
the endpoints remain below threshold. A best-residual middle representative
removes both endpoint duplicates; a best-residual endpoint preserves the other
endpoint. Test all input permutations with dense and CSR mass actions, preserving
original strict output and final frequency ordering. Source owners are
`mode_deduplication.cpp` and `mode_deduplication_test.cpp`; this correction alone
qualifies neither an eigensolver runtime nor a physical DE/BV dispersion curve.


### Generic refill budget telemetry: available exhaustion is explicit

The generic NEV-refill diagnostic publishes the adapter's
`outer_iteration_budget_exhausted` beside `iteration_budget_available` and the
cumulative count, as the other formatter already does. Interpret exhaustion
only with availability evidence. It means no cumulative outer-iteration budget
remains for a further attempt; it does not necessarily mean EPS diverged.
GHA37879661027 returned positive EPS reason1 with budget1/cumulative1, zero
certified modes and an explicit refill-budget stop reason. The diagnostic omitted
the bool, causing the existing unchanged C-ABI regression to fail. The proposed
serializer correction does not change the budget, residual gate, admission,
mode output or EPS termination policy. The fixture's residual1e-30 rejects
candidates and exercises lack of remaining refill budget after a converged EPS
attempt; it is not proof of EPS_DIVERGED_ITS. Fresh hosted execution of the
serializer correction is **NOT VERIFIED**.


## Korekta składania statycznego Robina: nowe wpisy grafu macierzy

Źródłowa diagnoza z 9 października 2026 dotyczy właściciela FEM Poisson
Robin, `initialize_demag_poisson_boundary_operator`. Realizacja zachowuje
istniejącą formę słabą; nie zmienia modelu magnetostatyki ani wartości beta.

```{math}
:label: eq-static-robin-graph-union
(A_R)_{ij}=K_{ij}+\beta(B_\Gamma)_{ij},\qquad
K_{ij}=\int_\Omega \nabla N_i\cdot\nabla N_j\,dV,\qquad
(B_\Gamma)_{ij}=\int_\Gamma N_iN_j\,dS.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $A_R$ | pełny operator Poissona z Robinem | $\mathrm{m}$ |
| $K$ | macierz dyfuzji potencjału | $\mathrm{m}$ |
| $B_\Gamma$ | macierz masy na granicy Robina | $\mathrm{m}^2$ |
| $\beta$ | efektywny współczynnik Robina | $\mathrm{m}^{-1}$ |
| $N_i$ | skalarna funkcja bazowa i | $1$ |
| $N_j$ | skalarna funkcja bazowa j | $1$ |
| $i$ | indeks stopnia swobody | $1$ |
| $j$ | indeks stopnia swobody | $1$ |
| $\Omega$ | obszar potencjału z airboxem | $\mathrm{m}^3$ |
| $\Gamma$ | aktywna granica Robina bez seam | $\mathrm{m}^2$ |
| $\nabla$ | gradient przestrzenny | $\mathrm{m}^{-1}$ |
| $dV$ | miara objętości | $\mathrm{m}^3$ |
| $dS$ | miara powierzchni | $\mathrm{m}^2$ |
| $\ell$ | długość krawędzi osiowego Tet4 w fixture | $\mathrm{m}$ |

Graf $B_\Gamma$ nie musi być podzbiorem grafu $K$: zerowy iloczyn
gradientów nie oznacza zerowego całkowanego iloczynu funkcji na granicy.
Metoda member `SparseMatrix::Add` w MFEM4.8 aktualizuje istniejące wpisy,
nie tworząc nowych połączeń. Poprawka ma stosować sumowanie z unią grafów
obu macierzy, z zachowaniem ownership, markerów, beta, gauge i tolerancji.
Źródła pierwotne: [member Add](https://github.com/mfem/mfem/blob/v4.8/linalg/sparsemat.cpp#L3069)
i [graph-union Add](https://github.com/mfem/mfem/blob/v4.8/linalg/sparsemat.cpp#L3906).

W rzeczywistym count CI37890812855 (źródła
20e2cc6e4bff2c2394a62a75323f9bb4adf59dab) mapy klas były identyczne.
Dwa symetryczne wpisy różniły się o0.22767090063073975. W syntetycznym
Tet4 airboxu każde z dwóch brakujących sprzężeń wnosi
$\beta\ell^2(1+\sqrt{3})/24$, gdzie $\ell=1\,\mathrm{m}$ oraz
$\beta=1\,\mathrm{m}^{-1}$ dają $0.11383545031536987\,\mathrm{m}$.
Nie jest to parametr dobrany do otrzymanego widma. Pełny fixture ma dziesięć
węzłów; węzeł air-only ma indeks9, a pominięte sprzężenia dotyczą indeksów1/2
przy indeksowaniu od zera, przed redukcją periodyczną.
Pozostałe47 wpisów operatora zredukowanego zgadzały się. Nie zmieniamy
oracle static/shared ani jego względnej tolerancji1e-10.

Weryfikacja ma obejmować obecność nowych full-node coupling slots,
analityczne wartości Robin i istniejącą zgodność pełnych zredukowanych
operatorów. Zmiana dotyczy składania hostowego operatora FEM; nie dotyczy
FDM i nie dowodzi wykonania FEM GPU, zbieżności airboxu/siatki ani zgodności
pełnej dyspersji z COMSOL. Publiczny Python, UI, ProblemIR, planner i
kontrakt jednostek pozostają bez zmian. Nowa realizacja oraz jej wpływ na
pole statyczne i częstotliwości pozostają **NOT VERIFIED** do świeżego CI
oraz wymaganych osobnych bramek runtime i nauki.


| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-static-robin-boundary-graph-union | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` :: `bool initialize_demag_poisson_boundary_operator` | Składanie operatora Robina, FEM host; source/scientific review PASS, native wykonanie pending |


Po korekcie wymagane jest ponowne obliczenie lub kwalifikacja stanów równowagi
i częstotliwości zależnych od starego statycznego Robina. Historyczne
artefakty i ich source/runtime identity pozostają zachowane; nie podnosimy
retroaktywnie ich statusu i nie uznajemy nowego source review za potwierdzenie
wcześniejszych wyników. Zgodność nowej macierzy nie zastępuje zbieżności
siatki/airboxu i porównania z analityką lub COMSOL.


## Kontrakt quantity dla zapisu widma eigen

Publiczny selector `spectrum_quantity` (oraz `SaveSpectrum.quantity`) ma
obsługiwać wyłącznie token `eigenfrequency`. Istniejący writer zapisuje
częstotliwości własne; nie implementuje odrębnego widma dla dowolnej nazwy
quantity. Nazwy kolumn wynikowych `frequency_hz` i `frequency_real_hz` nie
są aliasami wejściowymi. Nie zmieniamy wartości częstotliwości, jednostek
Hz, normalizacji modów ani sposobu rozwiązywania problemu eigen.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SaveSpectrum.quantity` | `str` | `"eigenfrequency"` | $1$ | Only `eigenfrequency`; other values raise a descriptive error. | Identifies the eigenfrequency spectrum; numeric values remain in Hz. | Common authoring; runtime capability-gated | `sampling.outputs[].quantity` for `kind="eigen_spectrum"`. |
| `study.save.spectrum_quantity` | `str` | `"eigenfrequency"` | $1$ | Same validation as `SaveSpectrum.quantity`. | Public stage selector for the eigenfrequency spectrum. | Common authoring; runtime capability-gated | Preserved as `sampling.outputs[].quantity`. |

Zamierzona walidacja obejmuje konstruktor Python, semantyczną walidację IR,
planner i selekcję runnera. Nie normalizujemy nieobsługiwanej nazwy do
wartości domyślnej ani nie łączymy różnych quantity w jedno żądanie bez
błędu. Format pola IR pozostaje stringiem; odczyt i serializacja historycznych
dokumentów nie są automatyczną kwalifikacją do wykonania. Błąd walidacji
nie usuwa ani nie przepisuje historycznych artefaktów. `scope` pozostaje
odrębnym kontraktem i nie jest naprawiany przez ten selector quantity.

| Realizacja | Walidacja quantity | Dowód wykonania nowych kontroli |
|---|---|---|
| FDM CPU | wspólny kontrakt authoring/IR; bez zmiany dostępności solvera | NOT VERIFIED |
| FDM GPU | wspólny kontrakt authoring/IR; bez CPU fallback | NOT VERIFIED |
| FEM CPU | wspólny kontrakt i runner output selection | NOT VERIFIED |
| FEM GPU | wspólny kontrakt i runner output selection; bez CPU fallback | NOT VERIFIED |

Bramki mają sprawdzać zachowanie domyślnego/canonical żądania,
Python→IR, odrzucenie pustego i nieobsługiwanego quantity, walidację
bez zmiany wejścia, przejrzysty błąd planner/runner oraz zachowanie
kanonicznego eksportu skryptu. Obowiązkowe dowody jakości modów nie mogą
zostać usunięte z wyników w celu obejścia tej walidacji. Walidatory Python, V0.3/V0.4, planner i selektor ścieżki oraz ręczny
FEM Single-k mają wspólną semantykę canonical token. Zachowana jest istniejąca
normalizacja whitespace z Python API; nie jest to nowy alias quantity.
Source review i walidator dokumentacji: PASS; wykonanie nowych regresji
w GitHub Actions jest **NOT VERIFIED**.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-eigen-spectrum-python-quantity | `packages/fullmag-py/src/fullmag/model/outputs.py` :: `class SaveSpectrum` | Publiczny selector; source review PASS, wykonanie nowych regresji GHA NOT VERIFIED |
| source-eigen-spectrum-runner-quantity | `crates/fullmag-runner/src/eigen/output_selection.rs` :: `select_eigen_outputs` | Nie scala nieobsługiwanych quantity do boola; source review PASS, GHA NOT VERIFIED |

| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-eigen-spectrum-ir-quantity | `crates/fullmag-ir/src/lib.rs` :: `is_supported_eigen_spectrum_quantity` | Wspólny canonical predicate; semantic V0.3 validation. Source review PASS, GHA NOT VERIFIED. |
| source-eigen-spectrum-v04-quantity | `crates/fullmag-ir/src/study_v04.rs` :: `validation_errors` | Semantic V0.4 przez legacy_validation_view i wspólne validate_study_contracts, bez zmiany raw serde. Source review PASS, GHA NOT VERIFIED. |
| source-eigen-spectrum-plan-quantity | `crates/fullmag-plan/src/validate.rs` :: `validate_eigen_outputs` | Planner reject unsupported spectrum quantity, canonical duplicate identity. Source review PASS, GHA NOT VERIFIED. |
| source-eigen-spectrum-single-quantity | `crates/fullmag-runner/src/fem/eigen_execution.rs` :: `execute_fem_eigen_inner` | Guard przed handoff/providerem dla ręcznego Single-k; source review PASS, GHA NOT VERIFIED. |

## Proveniencja wykonania ścieżki k

Ścieżka k jest sekwencją niezależnie rozwiązanych próbek. Próbka Γ (K=0)
i próbka z niezerowym wektorem Floqueta mogą używać innych adapterów,
konwencji fazowej, rezydencji i stanu walidacji. Manifest ścieżki nie może
więc wyprowadzać globalnego `resolved_execution` ani `physics.phase_convention`
z pierwszej próbki.

Pola globalne `resolved_execution` i pola diagnostyczne walidacji opisują wartość wspólną tylko wtedy, gdy każda
próbka ma jawne odpowiednie metadane i wartości są zgodne. Rozbieżność lub
brak w którejkolwiek próbce daje `null`; globalne pola nie są uzupełniane
etykietą z orkiestratora ani modelem solvera. `requested_execution` nadal
opisuje plan i żądanie użytkownika, a `physics` opisuje wspólny plan fizyczny.
Requested fields such as `solver_method`, `preconditioner` and
`magnetostatic_bc` use plan-level requested intent when no sample diagnostic
reports them. If any sample reports a field, the manifest emits it only when
every sample reports the same value; incomplete or differing evidence gives
`null`. These values describe requested intent, not resolved execution. The
label `orchestrator_only_reference` explicitly marks the limited legacy
reference/model values retained for a reference path without native diagnostics.
`physics.phase_convention` oznacza tu czasową konwencję fazora. Agreguje
wyłącznie per-sample diagnostyczne `phasor_convention` (exp_±iωt); wymaga
zgodności jawnych wartości we wszystkich próbkach. Przestrzenna
`phase_convention` SpinWaveBC/Floqueta jest innym polem i nie zastępuje fazora.

Manifest dodaje kompaktowe `sample_execution_provenance` w kolejności
próbek rozwiązanych przez orkiestrator. Każdy wpis zachowuje indeks, etykietę
i wektor k, dostępność diagnostyki oraz obecne requested/resolved execution,
rezydencję, fallback i stan walidacji. Brakujące pola pozostają `null`;
pełne diagnostyki nadal należą do osobnego artefaktu
`eigen/diagnostics/solver.v1.json` i nie są kopiowane do manifestu. Stan
podsumowania rozróżnia: `homogeneous` (diagnostyka jest dostępna dla każdej
próbki, a porównywane deskryptory wykonania mają zgodne raportowane wartości;
pola nieobecne we wszystkich próbkach pozostają `null` i nie powodują `partial`),
`mixed` (jawne deskryptory wykonania różnią się), `partial` (brakuje diagnostyki
lub porównywanego deskryptora w części próbek, bez jawnego konfliktu), `missing`
(brak porównywanych deskryptorów wykonania; licznik brakujących diagnostyk
pozostaje jawny) oraz `orchestrator_only_reference` dla rozpoznanej
referencyjnej ścieżki bez diagnostyk native. `homogeneous` oznacza zgodność
dostępnych raportowanych deskryptorów, a nie kompletność wszystkich pól,
walidację ani kwalifikację naukową. `orchestrator_only_reference` zachowuje
ograniczone wartości modelu referencyjnego; nie jest pomiarem rezydencji ani
dowodem adaptera native. Nieznane wykonanie native pozostaje nieznane.
Żaden status nie podnosi walidacji źródłowej ani kwalifikacji naukowej.

| Pole | Agregacja globalna | Zachowanie szczegółów |
|---|---|---|
| `resolved_execution` oraz pola diagnostyczne walidacji | Wartość tylko przy zgodności jawnego pola we wszystkich próbkach; inaczej `null`. | Wartości per próbka i ich dostępność są w `sample_execution_provenance.samples[]`. |
| `physics.phase_convention` | Wartość tylko przy zgodności jawnego `phasor_convention` we wszystkich próbkach; brak lub różnica daje `null`. | Zachowana czasowa konwencja fazora per próbka; przestrzenna `phase_convention` pozostaje osobnym polem. |
| Żądanie użytkownika i fizyka planu | Pozostają polami planu; nie są zastępowane przez rozwiązanie próbki Γ. | Diagnostyczne różnice per próbka pozostają widoczne w rekordach. |

Ta agregacja opisuje pochodzenie wykonania. Nie zmienia równań, solvera,
fallbacku, rezydencji, wyniku widma ani statusu walidacji metody. Kontrakt
i regresje są source-level; pełne testy Rust i wykonanie naukowe pozostają
**NOT VERIFIED** do GitHub Actions oraz właściwych bramek.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-eigen-path-sample-execution-provenance | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` :: `eigen_path_sample_execution_provenance` | Globalne wartości tylko dla wspólnych jawnych metadanych; kompaktowe rekordy per próbka zachowują mieszane/brakujące provenance i kolejność. Source review pending; Rust/GHA i runtime NOT VERIFIED. |

## Kontrakt publikacji diagnostyki eigen

`SaveEigenDiagnostics` oraz `study.save("diagnostics", ...)` przyjmują pięć
niezależnych flag typu `bool`: `include_tracking`, `include_residuals`,
`include_overlaps`, `include_tangent_leakage` i `include_orthogonality`.
W Pythonie i w aktywnym IR brak flagi oznacza `True`; jawne `False` pozostaje
intencją użytkownika, a `null` jest błędem. Wartości spoza `bool`, w tym
napisy takie jak `"false"`, nie są konwertowane truthy/falsy. V0.4 zachowuje
te same domyślne wartości przy braku pól i odrzuca jawne `null`. Gdy wejście
zawiera kilka `eigen_diagnostics`, każda flaga jest łączona operacją OR.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SaveEigenDiagnostics.include_tracking` / `study.save.include_tracking` | `bool` | `True` | $1$ | Wyłącznie wartość typu `bool`; inne typy są błędem. | Publikuje podsumowanie i rekordy śledzenia gałęzi w dedykowanej diagnostyce. | Wspólna authoring surface; dostępność danych zależy od writer/runtime. | `sampling.outputs[].include_tracking` dla `kind="eigen_diagnostics"`. |
| `SaveEigenDiagnostics.include_residuals` / `study.save.include_residuals` | `bool` | `True` | $1$ | Wyłącznie wartość typu `bool`; inne typy są błędem. | Publikuje raportowane residuale absolutne L2, względne L2 i L∞ dla obliczonych modów. | Wspólna authoring surface; metryki zależą od raportu solvera. | `sampling.outputs[].include_residuals`. |
| `SaveEigenDiagnostics.include_overlaps` / `study.save.include_overlaps` | `bool` | `True` | $1$ | Wyłącznie wartość typu `bool`; inne typy są błędem. | Publikuje zmierzone nakładanie modów wraz z identyfikatorami prób i modów oraz definicją metryki. | Wspólna authoring surface; wymaga poprzednika i pomiaru krawędzi śledzenia. | `sampling.outputs[].include_overlaps`. |
| `SaveEigenDiagnostics.include_tangent_leakage` / `study.save.include_tangent_leakage` | `bool` | `True` | $1$ | Wyłącznie wartość typu `bool`; inne typy są błędem. | Publikuje raportowane średnie, maksymalne i ważone względne przecieki styczne. | Wspólna authoring surface; metryki zależą od dostępnych danych modów. | `sampling.outputs[].include_tangent_leakage`. |
| `SaveEigenDiagnostics.include_orthogonality` / `study.save.include_orthogonality` | `bool` | `True` | $1$ | Wyłącznie wartość typu `bool`; inne typy są błędem. | Publikuje wyłącznie dostępne iloczyny skalarne modów obliczone z właściwą macierzą masy. | Wspólna authoring surface; dostępność zależy od solvera. | `sampling.outputs[].include_orthogonality`. |

Flagi filtrują wyłącznie dedykowaną publikację `eigen/diagnostics.v2.json`.
Nie zmieniają rozwiązania widma, żądanej liczby modów, admission residuali,
obowiązkowego solver diagnostics v1, manifestu wykonania ani innych
źródłowych danych naukowych. Brak `eigen_diagnostics` nie jest domyślnym
żądaniem diagnostyki. Dla istniejącego żądania z pięcioma flagami `False`
writer publikuje pięć sekcji ze statusem `not_requested`, `available: false`
i `data: null`. Gdy flaga jest włączona, sekcja zawiera wyłącznie dane
rzeczywiście dostępne albo jawny status i powód braku.

Sekcje `tracking`, `residuals`, `overlaps`, `tangent_leakage` i
`orthogonality` mają pola `status`, `available`, `data` oraz
`unavailable_reason`. Status `available` nie jest kwalifikacją naukową ani
dowodem wykonania urządzenia. Diagnostyka wyłącznie raportuje źródłowe dane.
Dla `residuals` i `tangent_leakage` każda składowa pozostaje typowanym
`Option` i jest publikowana tylko jako skończona, nieujemna liczba. Jawne zero
jest wartością, ale brak, NaN i liczba ujemna dają `null` z dostępnością lub
powodem właściwym dla tej składowej; writer nigdy nie zastępuje braku zerem.
Orthogonality pochodzi wyłącznie z kanonicznych wierszy iloczynu `uᵢᵀ M uⱼ`
z solverowego raportu opartego na macierzy masy. Bez takiego raportu sekcja
jest niedostępna; nie obliczamy iloczynu euklidesowego ani nie podstawiamy
zera.

Nakładania są raportowane wyłącznie dla rzeczywistych krawędzi śledzenia z
poprzednim i bieżącym `sample_index` oraz `raw_mode_index`, wartością pomiaru
i jawnie wskazaną metryką. `frequency_score_fallback` nie jest nakładaniem i
nie zwiększa jego dostępności. Gdy nie ma poprzednika, nakładanie ma status
`not_applicable` albo jawny powód braku, nigdy wartość zero. Żądanie
`include_overlaps=True` może uruchomić wewnętrzne śledzenie potrzebne do
pomiaru; nie zmienia wtedy `include_tracking=False` ani nie publikuje rekordów
śledzenia. W diagnostyce wyłącznie diagnostycznej wybierane są własne
identyfikatory wszystkich obliczonych modów, lecz nie powstaje publiczne
widmo ani payload pola modu.

Envelope v2 zachowuje istniejący resource i sekcję `dispersion` z podstawowymi
licznikami próbek i żądanych modów. Wyłączenie śledzenia nie publikuje metryk
ani rekordów śledzenia. Root `solver_model` ma jawny scope modelu ścieżki
orkiestratora. Polityka transportu bazy i geometria Floqueta pochodzą z
`modal_tangent_transport_diagnostics` dla każdej próbki mającej już rekord
diagnostics; pola adaptera i wykonania pozostają przypisane do źródłowych
rekordów solvera. Root publikuje wartość tylko wtedy, gdy jawne wartości są
wspólne dla wszystkich próbek. Brak lub rozbieżność pozostawia `null`;
kompaktowe rekordy prób zachowują per-sample dostępność. Root nie odtwarza pól
wykonania z pierwszego adaptera ani nie zastępuje requested intent wynikami
wykonania.

FEM path, ręczny single-k oraz generic manifest używają jawnego kontekstu
rzeczywistych outputów do utworzenia envelope v2. Manual single-k tworzy go
tylko przy obecnym `eigen_diagnostics`; tracking i nakładanie jednej próbki
nie mają krawędzi z poprzednikiem. Generic `eigen/diagnostics/solver.v1.json`
pozostaje niezależnym obowiązkowym artefaktem i nie jest filtrowany tymi
flagami. Frontend korzysta z istniejącego resource-first hooka i endpointu
`/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2`; zmiana
kształtu payloadu nie dodaje surowego endpointu ani nowego transportu.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
|---|---|---|
| source-eigen-diagnostics-python | `packages/fullmag-py/src/fullmag/model/outputs.py` :: `class SaveEigenDiagnostics` | Pięć flag `bool`, domyślnie `True`, bez truthy-coercion; Python tests/GHA NOT VERIFIED. |
| source-eigen-diagnostics-ir | `crates/fullmag-ir/src/study.rs` :: `OutputIR::EigenDiagnostics` | Domyślne flagi V0.3 i zachowanie jawnego `False`; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-v04 | `crates/fullmag-ir/src/v04_spectral_wire.rs` :: `OutputV04Wire::EigenDiagnostics` | Zgodne defaulty V0.4 i odrzucenie `null`; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-selection | `crates/fullmag-runner/src/eigen/output_selection.rs` :: `select_eigen_outputs` | Łączenie flag OR, oddzielne IDs diagnostyki i tracking wewnętrzny; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-artifact | `crates/fullmag-runner/src/eigen/diagnostic_artifact.rs` :: `build_eigen_diagnostics_v2` | Projekcja typed optional metrics, measured tracking edges, pięciu sekcji i common-only root transport metadata; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-transport-geometry | `crates/fullmag-runner/src/fem/eigen_output.rs` :: `modal_tangent_transport_diagnostics` | Źródłowy producer polityki i geometrii transportu baz Floquet; projekcja uzupełnia tylko brakujące klucze istniejących rekordów, bez mutacji raw solver diagnostics; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-common-provenance | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` :: `eigen_path_sample_execution_provenance` | Common-only observed fields oraz per-sample availability bez first-sample fallback; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-fem-path | `crates/fullmag-runner/src/fem/eigen_path.rs` :: `execute_fem_eigen_path_with_producer_identity_and_parallel_policy` | Istniejący v2 resource i ścieżka diagnostyczna dla pełnego k-path; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-native | `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` :: `native_modal_artifacts` | Dedykowany v2 dla rzeczywistego single-k request; raw summary pozostaje bez zmian; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-reference | `crates/fullmag-runner/src/fem/eigen_execution.rs` :: `execute_fem_eigen_inner` | Ręczny single-k reference writer publikuje tylko żądane sekcje z typed values i bez krawędzi poprzednika; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-generic | `crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs` :: `write_frequency_domain_eigen_manifest_with_outputs` | Jawny output i requested-mode context dla v2; raw solver v1 pozostaje niezależny; Rust/GHA NOT VERIFIED. |
| source-eigen-diagnostics-resource | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` :: `useFrequencyDomainEigenDiagnosticsResource` | Istniejący resource-first hook i endpoint; bez nowego endpointu. |
| source-eigen-diagnostics-frontend-shape | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` :: `eigenDiagnosticTransportSummary` | Konsument oczekuje root-level transport fields, niezależnych od sekcji `dispersion`. |

## Kanoniczna ścieżka benchmarku COMSOL — uwaga 4082209300

Dla C1/A1 referencją jest wersjonowana tabela docs/guides/comsol-dispersion-benchmark/kpath.csv:61 indeksów0..60 ścieżki Γ–X–M–Γ, wektory w rad/m. Opcjonalny --kpath pozostaje wejściem do sprawdzenia, nie nową definicją benchmarku. Po parsowaniu każdy indeks i trzy składowe float64 muszą odpowiadać referencji dokładnie; inny zapis tego samego numeru/BOM jest dozwolony. Duplicate index, brak/przesunięcie indeksu, zmieniony wektor lub nieczytelna/uszkodzona referencja blokuje kwalifikację. Labels i dodatkowe kolumny prezentacyjne nie zastępują wektorów. C0 single-Γ nie potrzebuje path check.

Dalsza walidacja spectrum/CSV/analityki używa wyłącznie oczekiwanych wektorów repozytoryjnych, również przy odrzuconym override. Raport ma osobny mandatory canonical_kpath check, odrębny od liczby zwróconych sample. Nie zmienia to równań, publicznego Python/ProblemIR ani backendów; gate ocenia artefakty FEM CPU/GPU, bez kwalifikacji FDM. Regresje mają odrzucić self-consistent all-Gamma override oraz duplicate/renumbered/changed-vector input i zachować semantycznie identyczną kopię. Niezależny SOURCE review PASS; hosted GHA37979402458/job113985786736:63 scientific-gate tests PASS, w tym trzy nowe regresje override/copy/mandatory check. Job Python później FAIL w odrębnym meshing ROI density. To dowód bramki wiązania benchmarku, nie dowód zgodności numerycznej FEM z COMSOL.

### Pełne pokrycie fazowe wybranych pól modalnych

Dla C1/A1 kontrola pola obejmuje wszystkie 61 kanonicznych próbek k oraz osiem
wybranych gałęzi. Każda para `(sample_index, raw_mode_index)` jest odrębnym
wyborem, zatem oczekiwanych jest $61 \times 8 = 488$ unikalnych certyfikatów pól.
Surowe identyfikatory modów pozostają rozróżnione także przy zdegenerowanych
częstotliwościach. Certyfikator czyta każdy rzeczywisty binarny wektor
magnetyczny i zachowuje kontrolę hashy, siatki, k oraz quasiperiodycznej fazy.
Siedem punktów używanych przez osobne kontrole zbieżności nie ogranicza tego
zakresu. Brak lub uszkodzenie wybranego pola w j=30 ma obniżyć
`modal_field_phase`, nawet gdy pozostałe punkty kontrolne i widmo są kompletne.
Dla C0 pozostaje jeden wybrany mod w Γ.

To twierdzenie dotyczy fazy opublikowanych zespolonych pól magnetycznych.
Bramka nie certyfikuje pełnego pola skalarnego $\phi$, jego równania Poissona,
airboxu ani pełnego residualu descriptora. Pełna kwalifikacja $\phi$ dla
bieżącej ścieżki k pozostaje NOT VERIFIED.

| Source ID | Plik | Symbol | Zakres dowodu |
| --- | --- | --- | --- |
| source-comsol-modal-field-coverage-gate | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_exported_mode_fields | Wymaga wszystkich 61 × 8 unikalnych par próbka/raw mode dla C1/A1; siedem punktów zbieżności nie ogranicza certyfikacji pola. |
| source-comsol-modal-field-certificate | scripts/comsol_modal_field_certificate.py | validate_modal_field_certificate | Niezależnie czyta wybrane binarne wektory magnetyczne, wiąże ich hashe i sprawdza fazę na parach periodycznych. |
| source-comsol-modal-field-fixture | scripts/test_validate_comsol_dispersion_scientific_gate.py | _write_mode_fields | Tworzy syntetyczne binarne payloady dla wszystkich próbek fixture; nie jest obliczeniem modu FEM. |
| source-comsol-modal-field-fullpath-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_modal_field_phase_covers_every_selected_path_mode | Publiczna validate_case sprawdza pełne 488 par, zachowując raw mode IDs jako odrębne wybory. |
| source-comsol-modal-field-interior-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_missing_or_corrupt_j30_modal_field_fails_phase_check | Brak lub korupcja wybranego pola w j=30 obniża konkretnie modal_field_phase. |

### Niezależna walidacja accepted equilibrium dla primary modes

Każda próbka i każdy primary mode wybrany przez śledzoną gałąź musi dodatkowo
przejść primary_equilibrium, niezależnie od zastosowania kontroli
Kalinikos–Slavin. not_applicable dla KS w C0 i A1 oznacza wyłącznie brak
zastosowania jednorodnofilmowej formuły; nie zastępuje accepted equilibrium.
Kontrola czyta rzeczywisty mode metadata i wywołuje
scripts/comsol_equilibrium_artifacts.py::read_sample_equilibrium dla
deklarowanego indeksu próbki i zaakceptowanego modu. Para plików pochodzi
wyłącznie z manifestu; nie jest wybierana po nazwie ani kolejności katalogu.
Czytnik weryfikuje akceptację, digesty plików, aktualny mesh, zewnętrzne pole,
podpis fizyki planu i rzeczywisty znormalizowany magnetyczny m0. Bieżący
MaterialIR jest sprawdzany osobno przez _validate_primary_equilibrium oraz
dokładny replay preimage’ów; czytnik nie rozstrzyga producer/consumer raw
material identity. Dotyczy to każdego raw mode wybranego przez primary branch
na każdej próbce. Brak próbki, modu, pliku, poprawnej akceptacji lub zgodnego
digestu blokuje bramkę.
Replay preimage’ów identity obejmuje także boundary; kontrola nie zastępuje
niezależnej walidacji operatora ani kwalifikacji fizycznej spectrum.
Identity linearization_identity.v2 i jego dokładny preimage są rozwiązywane
wyłącznie przez ścieżki zadeklarowane w manifest.artifacts. Gate odtwarza
digest preimage, pięć podpisanych preimage’ów fizyki oraz producer i consumer
raw MaterialIR. Consumer raw preimage musi odpowiadać bieżącemu planowi;
fizyczne projekcje producer i consumer muszą odpowiadać zaakceptowanemu
podpisowi materiału. Raw signature w utrwalonym equilibrium i state odpowiada
material_provenance_signature, czyli hashowi bieżącego consumer planu.
linearization_identity.v2 przechowuje osobno
producer_material_provenance_signature i dokładny producer raw preimage. W rodzinie
canonical v2 te raw provenance mogą się różnić, jeżeli fizyczna projekcja
jest równa. Legacy raw v1 wymaga zgodności obu raw digestów. Projekcja
odwzorowuje Rust: jawne Ku=0 z polem Ms albo authored zerową osią używa
fizycznego preimage v1; jednorodne Ms z poprawną osią zachowuje v2. Rodzina
identity nadal zależy od obecności opcji Ku, niezależnie od wybranego
fizycznego preimage’u.
Identity source_run_id jest porównywane z producer_run_id zaakceptowanego
equilibrium oraz z producer_run_id stanu, jeśli stan go publikuje. Jawne
producer_stage_id/source_stage_id w payloadzie muszą odpowiadać identity
source_stage_id. Para v7/v6 nie publikuje stage ID, więc raport oznacza je jako
content-bound, but not published by equilibrium state; gate nie wyprowadza
stage owner z bieżącego runu eigen.

Jeżeli solver diagnostics publikuje AcceptedFemEigenEquilibriumHandoff.v1,
gate odtwarza jego content hash i porównuje digesty equilibrium/state, source
topology oraz stage FEM mesh generation z per-mode metadata. Handoff v1 nie
zawiera run/stage owner; te pola są sprawdzane wyłącznie tam, gdzie publikuje
je identity lub accepted state. Brak jawnego stage ID w v7/v6 pozostaje
ograniczeniem, a nie dowodem zgodności stage. Pełny producer artifact-hash
replay i kwalifikacja operatora nadal należą do odrębnych bramek R4.
| Source ID | Plik | Symbol | Zakres dowodu |
| --- | --- | --- | --- |
| source-comsol-primary-equilibrium-gate | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_primary_equilibrium | Wymaga accepted equilibrium/linearization dla każdego primary sample i selected mode; exact producer/consumer preimage replay wiąże bieżący MaterialIR. |
| source-comsol-primary-equilibrium-reader | scripts/comsol_equilibrium_artifacts.py | read_sample_equilibrium | Weryfikuje przyjęty artifact, per-mode content hashes, bieżący mesh/external-field/physics i znormalizowane magnetyczne m0; current MaterialIR replay wykonuje gate. |
| source-comsol-primary-equilibrium-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_equilibrium_is_mandatory_for_c0_c1_a1 | Przechodzi publiczną validate_case dla C0/C1/A1 oraz odrzuca brakujące lub niespójne wiązania bez zmiany stosowalności KS. |
| source-comsol-primary-equilibrium-negative-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_equilibrium_rejects_stale_and_mismatched_bindings | Odrzuca brak mode metadata, nieaktualny digest stanu, błędny source run/topology, materiał/fizykę oraz nieodtworzony identity preimage. |
| source-fem-producer-material-preimage | scripts/fem_producer_provenance_replay.py | _validate_material_preimages_from_exact_bytes | Odtwarza dokładne raw preimage producer i consumer oraz porównuje ich fizyczną projekcję z zaakceptowanym podpisem Rust. |
| source-fem-producer-material-preimage-regression | scripts/test_fem_producer_provenance_replay.py | test_material_preimage_projection_matches_rust_zero_ku_rules | Pokrywa brak Ku, fizyczną projekcję V1/V2 przy zerowym Ku oraz kanoniczne reuse z różnym raw provenance i zgodną fizyką. |
| source-comsol-primary-canonical-v8-v7-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_canonical_v8_v7_reuse_binds_both_raw_material_plans | Public validate_case dopuszcza różne producer/consumer raw preimage’y przy zgodnej fizycznej projekcji; accepted v8/v7 raw signature pozostaje consumer-bound. |
| source-comsol-primary-canonical-material-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_canonical_v8_v7_rejects_current_physical_material_changes | Odrzuca self-consistent consumer raw MaterialIR po zmianie Ms, A, Ku, ms_field lub a_field wobec zaakceptowanego producer physical signature. |
| source-comsol-primary-ku0-preimage-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_canonical_ku0_uses_physical_v1_preimage | Public canonical v8/v7 path zachowuje fizyczny EquilibriumMaterialSignaturePreimage.v1 dla jawnego Ku=0 z authored zerową osią. |

## Ranking ośmiu najniższych modów w bramce C1/A1

Dla każdej próbki ścieżki C1/A1 kandydatami do rankingu są wyłącznie dodatnie
częstotliwości widma, których rekordy przechodzą walidację natywnych residuali,
przecieku stycznego i pozostałych wymaganych pól jakości. Bramkę rozpoczyna
fizyczny ranking w próbce seed `sample_index=0`: sortuje częstotliwości w Hz,
a `raw_mode_index` służy wyłącznie do deterministycznego rozstrzygnięcia remisu
podczas przypisania seedów do ciągłych gałęzi. Równe częstotliwości z różnymi
raw ID pozostają osobnymi elementami multizbioru; nie są deduplikowane.

Osiem gałęzi wybiera się przez powiązanie ośmiu najniższych modów seed z ich
`branch_id`. `branch_id` jest tożsamością śledzonego rekordu, a nie rangą
fizyczną. Bramkę przechodzi tylko kompletny, ciągły zestaw tych śledzonych
tożsamości, którego osiem quality-admitted częstotliwości w każdej próbce ma
ten sam uporządkowany multizbiór co osiem najniższych dodatnich częstotliwości
tej próbki. Każda próbka nadal wymaga ośmiu odrębnych raw IDs, lecz przy remisie
degeneracyjnym na granicy zestawu poprawnym jest dowolny wybór raw ID o tej
samej częstotliwości; test nie narzuca seedowego tie-break każdej kolejnej
próbce. Multizbiór zachowuje krotność zdegenerowanych częstotliwości. Brak
niższego kandydata w śledzonym zestawie lub brak ciągłej gałęzi nie pozwala
zastąpić go kolejną kompletną gałęzią według liczbowego branch ID. C0 nadal
sprawdza jeden najniższy dodatni mod w Γ. Jest to kontrola zgodności artefaktów
z zadanym zakresem widma, nie dowód kompletności fizycznego widma ani
kwalifikacja solvera.

Dodatkowy warunek tożsamości fundamentalnej dotyczy tylko C0 i C1. W C1
`selected[0]` musi pozostać najniższą gałęzią w każdej próbce, ponieważ jest
porównywana z analitycznym widmem Kalinikos-Slavin n=0 jednorodnej warstwy.
A1 nie ma tego jednopasmowego oracle: antidot łamie założenie jednorodnej
warstwy. Dlatego w A1 dwie wybrane, ciągle śledzone gałęzie mogą zamienić się
kolejnością częstotliwości; wymagane pozostają kompletność, ciągłość ich
tożsamości, jakość modów, unikalne raw IDs i per-sample multizbiór całej
najniższej ósemki. Sam crossing nie wymaga utrzymania jednej gałęzi jako
minimum.

To sortowanie nie rozwiązuje niezależnej identyfikacji pasm między coarse,
medium i fine runami. `_validate_convergence_pair` nadal pobiera obserwacje po
`branch_id`; częstotliwościowy wybór w każdym runie nie dowodzi, że równe
numery branch ID oznaczają ten sam fizyczny mod. Dopasowanie cross-run przez
zweryfikowaną tożsamość/overlap pozostaje osobną otwartą bramką
(review 4080421130); do jej zamknięcia porównania zbieżności nie stanowią
kwalifikacji ciągłości fizycznych pasm.

| Source ID | Plik | Symbol | Zakres dowodu |
| --- | --- | --- | --- |
| source-comsol-quality-admitted-spectrum-ranking | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_spectrum | Zachowuje osobny zbiór dodatnich modów, które przechodzą _validate_modal_quality, do rankingu w każdej próbce. |
| source-comsol-lowest-eight-branch-selection | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_branches | Wybiera ciągłe gałęzie z ośmiu najniższych modów seed, sprawdza per-sample multizbiór z degeneracją i nie zastępuje brakującej gałęzi wyższym ID; minimum tej samej gałęzi jest dodatkowo wymagane tylko dla C0/C1, a A1 dopuszcza przecięcia wewnątrz wybranego zestawu. |
| source-comsol-lowest-eight-regressions | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_validate_case_selects_lowest_eight_by_seed_frequency_and_preserves_degeneracy | Public validate_case rozstrzyga permutowane branch IDs, degenerację jako odrębne raw IDs i brak ciągłego śledzenia niższego kandydata. |
| source-comsol-convergence-quality-ranking | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_bundle_modal_payload | Zachowuje dodatnie mody przechodzace kontrole jakosci w numeric convergence bundles dla tego samego rankingu; nie dopasowuje fizycznych pasm miedzy runami. |
| source-comsol-lowest-eight-degenerate-cutoff-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_lowest_eight_multiset_accepts_degeneracy_at_cutoff | Zachowuje krotnosc przy remisie na osmym miejscu i dopuszcza rozne raw ID reprezentujace rowna czestotliwosc. |
| source-comsol-quality-admission-ranking-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_spectrum_keeps_quality_failures_out_of_physical_ranking | Wyklucza dodatni mod z niepoprawnym residualem z rankingu i zachowuje powod jego odrzucenia. |
| source-comsol-a1-crossing-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_a1_selected_branches_may_cross_without_fundamental_identity | Sprawdza zamianę kolejności częstotliwości dwóch z ośmiu śledzonych gałęzi A1 przy zachowaniu tożsamości, unikalnych raw IDs i najniższego multizbioru; kontrola C1 nadal wymaga analitycznej gałęzi fundamentalnej. |
| source-comsol-a1-public-crossing-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_validate_case_a1_allows_two_of_eight_branches_to_cross | Public validate_case zachowuje wybrany zestaw A1 po przecięciu dwóch gałęzi i oznacza kontrolę fundamental_branch_check jako not_applicable, bez deklarowania pełnej kwalifikacji przypadku. |
| source-comsol-cross-run-branch-id-limitation | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_convergence_pair | Obecne porównanie runów po branch ID pozostaje odrębne od seed-rankingu i nie jest dowodem fizycznego dopasowania modów między siatkami. |

## Primary search request i kompletność okna

Kanonicznym źródłem żądań jest `eigen_search` w pliku
`parameters.json`: C0 przyjmuje dokładnie jeden żądany mod przy Γ, a C1/A1
rozpoczynają wyszukiwanie z limitem 24 modów. Wspólne okno żądane w Hz to
`frequency_window_hz = [1.0e6, 3.0e10]`. Są to żądania wejściowe, nie wyniki
solvera ani ustawienia polityki kompletności.

`requested_mode_count` jest dodatnim limitem liczby modów, które solver może
zwrócić z danego przeszukania; nie jest wymaganiem, by C1/A1 opublikowały 24
modów. Wybór ośmiu quality-admitted gałęzi do analizy dyspersji jest osobnym
kontraktem selekcji. Osiem opublikowanych modów może odpowiadać limitowi 24,
jeżeli natywne diagnostyki dla każdego `k` prawdziwie certyfikują, że właśnie
tyle modów znajduje się w żądanym oknie i nie ma dalszych modów w tym zakresie.

Authored `eigensolve`, `backend_plan.target/count` i diagnostyki solvera muszą
zachować ten sam limit i żądane okno. `resolved_search_window_hz` może być
szersze z powodu liczbowych guardów, ale musi obejmować całe żądane okno.
Dla C1/A1 każde sample ma własne żądanie i rozstrzygnięcie kompletności; poprawny
agregat nie może ukrywać sample z innym limitem, oknem lub statusem.

Kompletność pełnego okna jest oddzielna od zgodności wejściowych parametrów i
od wyboru ośmiu gałęzi. Do pełnej kwalifikacji każde wymagane sample musi mieć
jawne `window_completeness.status = "certified"`, poprawną metodę certyfikacji
i `additional_modes_may_exist = false`. Dla każdej próbki metoda
`contour_interval_count` oraz liczniki `estimated_modes_in_window`,
`certified_modes_in_window` i `returned_modes` muszą być jawne i zgodne.
Jeśli producent publikuje `accepted_modes_before_cap`, pole to również musi
być całkowite i równe `returned_modes`; jego brak jest dozwolony dla
konturowego producenta, który tego pola nie emituje. Liczba zwróconych modów
nie może przekraczać kanonicznego limitu requestu, a wynik nie może być
oznaczony jako ucięty. Sam fakt, że liczba zwróconych modów jest równa limitowi, nie dowodzi
ucięcia; rozstrzyga jawny status/truncation w diagnostyce. Podobnie sama liczba
wybranych gałęzi ani status agregatu nie zastępują zgodnych certyfikatów
poszczególnych próbek. Brak historycznych pól, status `not_certified`,
`partial_convergence` albo `truncated_by_requested_count` pozostają
`NOT VERIFIED`. Pole `window_completeness.policy` pozostaje diagnostyką
backendu i nie jest nową opcją publicznego DSL.

Obecny source writer ścieżki zapisuje agregat `not_certified` nawet wtedy, gdy
dołącza per-sample diagnostics. Do czasu publikowania zgodnego, dowodliwego
agregatu gate nie może uznać pełnej kompletności okna dla takiego primary runu.

| Source ID | Plik | Symbol | Zakres dowodu |
| --- | --- | --- | --- |
| source-comsol-primary-search-config-consumer | tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py | _canonical_eigen_search | Wczytuje kanoniczny limit C0, początkowy limit C1/A1 i wspólne okno Hz z docs/guides/comsol-dispersion-benchmark/parameters.json. |
| source-comsol-primary-search-binding | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_primary_search_parameters | Wiąże authored metadata, resolved FEM plan i aggregate/per-sample requested count oraz okna z canonical parameters. |
| source-comsol-primary-window-completeness | scripts/validate_comsol_dispersion_scientific_gate.py | _validate_primary_window_completeness | Zachowuje rozdział między poprawnym requestem a pełnym certyfikatem; wymaga returned modes w granicach canonical cap i opcjonalnego accepted_modes_before_cap tylko gdy producer go emituje. |
| source-comsol-primary-search-binding-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_search_parameters_bind_count_and_window_without_requiring_full_cap | Odrzuca self-consistent, ale niekanoniczny limit, brakujące lub niezgodne sample requests i niedomknięte okna; dopuszcza szerszy resolved guard. |
| source-comsol-primary-window-completeness-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_primary_window_completeness_requires_native_certificate_per_sample | Pokrywa contour schema bez accepted_modes_before_cap, opcjonalny licznik multi-shift, tryby 8/24 i 1/1 oraz odrzuca brak certyfikacji, sprzeczne liczniki i over-cap. |
| source-comsol-primary-window-public-producer-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_validate_case_accepts_contour_counts_without_optional_counter_and_rejects_over_cap | Public validate_case przyjmuje contour schema bez accepted_modes_before_cap i poprawny wariant z polem opcjonalnym, a odrzuca per-sample count ponad cap 24. |
| source-comsol-primary-malformed-spectrum-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_validate_case_malformed_spectrum_samples_fail_closed_without_exception | Public validate_case zwraca NOT VERIFIED dla spectrum.samples=null lub int, bez wyjątku. |
| source-comsol-primary-gamma-cap-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_campaign_contract_pass_cannot_qualify_inconsistent_tracking_replay | Public fixture potwierdza exact C0 count/certificate 1/1 oraz C1/A1 contour count 8 przy cap 24. |
| source-comsol-primary-config-regression | scripts/test_validate_comsol_dispersion_scientific_gate.py | test_benchmark_config_consumes_canonical_search_sheet | Porównuje limity C0/C1 i okno emitowane przez konfigurację workflow z kanonicznym arkuszem parametrów. |

## Rodzaj rekordu: progress nie jest obserwacją fizyczną

Doprecyzowanie ADR0004 dla naprawy4204792253: każda nowa próbka ma jawny rodzaj
`physical_observation` albo `solver_progress`. Modalny callback ma typowany
kanał diagnostyczny `solver_progress.fem_eigen`; nie jest fikcyjnym obiektem
sceny. Legalna nazwa obiektu `fem_eigen_progress` pozostaje zwykłym object_id.
Placeholdery energii, średniej magnetyzacji lub momentu w compatibility shimie
nie mogą być publikowane jako pomiar tylko dlatego, że mają wartość zero.
Żadna zmiana równania LLG, jednostek SI ani metryki residual nie wynika z tego
rozdzielenia. Ułamek postępu i liczniki są bezwymiarowe; czasy pozostają w sekundach,
a normy KSP zachowują deklarowaną skalę algebraiczną. Kanał pozostaje
telemetrią solvera; mod i stan równowagi wymagają niezależnych artefaktów
i certyfikatów.

Brak rodzaju w danych historycznych oznacza `legacy_unclassified`. Zachowujemy
surowe dane, ale nie przypisujemy im automatycznie znaczenia fizycznego ani
statusu kwalifikacji. Nowe typed kind i payload muszą być spójne na całej trasie
runner→CLI→API; nieznany kind i sprzeczny payload są odrzucane. Dokumentacja
opisuje wdrożony kontrakt: niezależny source review **PASS**, GHA/runtime **NOT VERIFIED**.
Poprzednio zaakceptowane pola mogą zachować swój odrębny dowód źródła po
callbacku postępu. Cache-only admission wymaga dokładnego replay wartości,
layoutu, revision i carrier; znajomość samego frame ID nie wystarcza. Jawny
starszy source_step bez czasu jest wyszukiwany w jego własnym fizycznym źródle,
bez dopisywania czasu bieżącego kroku. Magnetyzacja może być przenoszona tylko
między dwoma spójnymi krokami fizycznymi, nigdy do solver-progress frame.
Core producer→V2 i testy CLI/API są oddzielnymi regresjami; źródłowy test CLI
używa typowanego helpera postępu, nie dowodzi bezpośredniego native runtime chain.

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| source-modal-record-kind-quantity | crates/fullmag-quantities/src/step_data.rs | GlobalQuantityRow | Jawne admission ilości fizycznych; docelowy kontrakt typu rekordu, source review PASS; GHA/runtime NOT VERIFIED. |
| source-modal-record-kind-runner | crates/fullmag-runner/src/types.rs | to_quantity_row | Zachowanie rodzaju i oddzielenie numeric placeholders od pomiaru; source review PASS; GHA/runtime NOT VERIFIED. |
| source-modal-record-kind-api | crates/fullmag-api/src/session.rs | upsert_scalar_row | Admission physical rows bez klasyfikacji po identyfikatorze obiektu; source review PASS; GHA/runtime NOT VERIFIED. |

## Plan pomiaru kopii rzeczywistego Pmat — bez zmiany solvera

Stan: niezależny review źródeł ograniczonej diagnostyki opt-in **PASS**; wykonanie i kwalifikacja naukowa **NOT VERIFIED**.
Dla fixture w logu38044235857 mod0,517405523835Hz przechodził oryginalny
residual około2,92e-11. Późniejszy hardKSP nie jest wyjaśniony oknem. LivePC
powtarzalnie daje residual względny około7,54e-8, a świeże izolowane LU około
5,15e-16. Zgodność wskaźnika i jednego działania Pmat nie dowodzi równości
wszystkich wpisów ani struktury.

Następny pomiar kopiuje rzeczywisty borrowed Pmat podczas istniejącego
bezpiecznego callbacku, przed błędem EPS: MatDuplicate z MAT_COPY_VALUES,
nie współdzielenie struktury przez MAT_SHARE_NONZERO_PATTERN. Sprawdza wymiar,
strukturę, liczbę wpisów, pełną równość wartości, maksymalną różnicę wpisu i
względny defekt normy Frobeniusa względem niezależnego exact snapshot.
Dla reference norm=0 nie zgadujemy dzielnika ani poprawności; dostępność miary
względnej musi być jawna. Pełne porównanie dotyczy macierzy z jawnymi wpisami;
MatEqual dla matrix-free daje próbkowanie i nie wystarcza jako ten dowód.

Świeży, wyłącznie owned PC/LU działa na tej kopii i tym samym prywatnym RHS.
Zachowujemy faktycznie odczytany solver package i jawnie zapisane ustawienia
konstrukcji. Ustawień requested/configured nie opisujemy jako zmierzonych
actual; brak publicznego odczytu ustawienia jest reported jako unavailable,
nie zastępowany założeniem. Pełne porównanie jawnych wpisów jest ograniczone
do sekwencyjnego AIJ i wymiarów nie większych niż 512; inne typy lub większy
wymiar mają jawny status unavailable, bez próbkowanego substytutu dowodu.
Kalibracja wektora rozwiązania i obie normy residual
muszą korzystać z tych samych scale/RHS i oryginalnego operatora co live PC.
Nie zmieniamy live PC, jego factor workspace, tolerancji ani okna wyszukiwania.
Błędy i checked cleanup pozostają częścią prywatnej diagnostyki; nie wolno
wykonywać zapytań do grafu po hard EPS error.

Regresja błędu zwalniania widoku wiersza jest rejestrowana jako osobny CTest
`modal_eigen_borrowed_pmat_row_restore_fault_quarantine`, wykonywany w nowym
procesie przez istniejący profil CI `floquet-modal-slepc`. Po pierwszym błędzie
restore dalsze wywołania PETSc na niepewnym grafie są zabronione, a graf pozostaje
w kwarantannie. Liczniki NNZ muszą być zachowane przed restore; błąd pierwotny
odczytu oraz błąd cleanup pozostają oddzielnymi polami. Rejestracja testu nie
jest dowodem wykonania. Drugi osobny test
`modal_eigen_borrowed_pmat_row_primary_cleanup_fault_quarantine` sprawdza
odrębne kody błędu pierwotnego i cleanup. Weryfikacja obu ścieżek w GitHub Actions
pozostaje pending. Dodatkowa negatywna fixture
`modal_eigen_borrowed_pmat_pattern_mismatch_fixture` wywołuje ten sam comparator
na dwóch owned macierzach SeqAIJ 2x2 o odpowiednio 3 i 4 wpisach. Jej odrębne
pola `bounded_pattern_fixture_*` nie są pomiarem rzeczywistego Pmat. Test ma
wykrywać różną liczbę wpisów i różny wzorzec, bez zmiany operatora produkcyjnego;
niezależny review źródeł tej fixture PASS, wykonanie NOT VERIFIED.

Dokumentacja PETSc: [MatDuplicate](https://petsc.org/main/manualpages/Mat/MatDuplicate/),
[MatEqual](https://petsc.org/release/manualpages/Mat/MatEqual/),
[MatNorm](https://petsc.org/release/manualpages/Mat/MatNorm/),
[PCFactorGetMatSolverType](https://petsc.org/main/manualpages/PC/PCFactorGetMatSolverType/).

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| source-live-pmat-owned-copy-plan | backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp | capture_candidate_live_pc_observation | Ograniczony pomiar rzeczywistego Pmat w bezpiecznym callback; rozszerzenie w toku. |
| source-live-pmat-json-plan | backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp | std::string live_pc_observation_json | Jawne availability, configured/actual i residual z tej samej skali; rozszerzenie w toku. |


(r2-selected-search-stability-v2)=
## R2: two-pass stability nie jest count całego okna

Nowa emisja `poisson_airbox_frequency_window_certificate.v2` rozdziela
stabilność wybranych klastrów od kompletności całego widma. Dwa schedules,
większe NEV, dodatnie margins i zgodne subspaces mogą ominąć ten sam
nieodkryty blok niezmienniczy. Nie są niezależnym eigenvalue count.

CPU Schur i GPU K0 zachowują istniejące równania, wyszukiwanie, per-mode
residual gates, metrykę i poprawne mody. Udane wybrane widmo może mieć status
wykonania `ok` przy `window_complete=false`. Nowy certyfikat ma
`spectrum_scope=selected`, `status=not_certified`,
`count_certificate.status=not_performed`, `count=null`, `method=null`.
`search_stability.status=stable` oznacza tylko spełnienie dotychczasowych
bramek search/refinement, nie niezależny count ani naukową kwalifikację.
Brak count nie awansuje do `certified` także dla znanej małej fixture.
Błędy, anulowanie, niezgodność refinement lub obcięte diagnostics nadal
zachowują dotychczasową ścieżkę odrzucenia; nie obniżamy tolerancji.

Historyczne v1 nie są przepisywane ani promowane do dowodu count. Consumer
Krylov query może czytać oba schematy, gdy sprawdza wyłącznie parametry
wykonania; nie wydaje naukowego certyfikatu widma. Bramka COMSOL wymaga
właściwego niezależnego count, którego ten producent jeszcze nie dostarcza.
Istniejący contour owner pozostaje osobny i zachowuje swój count contract.
Wdrożenie independent count i kwalifikacja P4 pozostają otwarte.

| Source ID | Path | Symbol | Odpowiedzialność |
|---|---|---|---|
| source-r2-selected-window-cpu | backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | solve_poisson_airbox_modal_eigen_cpu_schur | Nowa emisja two-pass search stability bez count claim |
| source-r2-selected-window-gpu | backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp | solve_gpu_frequency_window | Odpowiedni kontrakt GPU bez promocji runtime qualification |

Regresje native hosted wymagają zachowanych częstotliwości/liczby modów,
obu schedules, ranks, overlap i margins, a równocześnie false complete i
jawnego braku count. GPU source/regression oczekuje osobnego wykonania GPU.


(r2-ui-signed-modal-decay)=
## R2: Inspector zachowuje growth i brak dostępnej FWHM

Inspector modułu `inspector` w istniejącym `panel-right` konsumuje zasoby
przez obecne resource hooks. Dla zespolonej częstotliwości f znak zaniku
wynika z jawnej konwencji phasoru i istniejącego `phasorConventionAdapter`.
Brak lub nieznany token oznacza niedostępne derived damping observables;
nie wybieramy domyślnego phasoru dla danych bez provenance.

Decay prezentowany w Hz ma etykietę `Gamma / 2 pi`, a lifetime jest w s.
Dodatni zanik oznacza decaying, ujemny growing, zero undamped. Nie wolno
stosować wartości bezwzględnej decay do FWHM ani zmieniać growth na damping.
FWHM jest dostępna tylko dla oscylującego stabilnego modu (zero dla idealnie
nietłumionego oscylatora). Nieoscylujące mody zachowują podpisany decay i
mogą mieć lifetime, lecz nie mają rezonansowej FWHM/Q. Lifetime wymaga
ściśle dodatniego decay; Q wymaga dodatniej FWHM. Derived nonfinite values
pozostają unavailable. Ta projekcja nie nadaje reference linewidth statusu
exact, nie kwalifikuje solvera i nie zmienia C ABI, OpenAPI ani IR.

| Source ID | Path | Symbol | Odpowiedzialność |
|---|---|---|---|
| source-r2-modal-damping-observables | apps/control-room/src/shared/domain/analysis/modalDampingObservables.ts | modalDampingObservables | Signed phasor-aware Gamma/FWHM/lifetime/Q availability |
| source-r2-modal-damping-inspector | apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.tsx | useEigenModeSummary | Istniejąca projekcja zasobów bez własnego transportu |

Testy GHA: oba jawne phasory, growth bez dodatniej FWHM, nieoscylujące
rozwiązanie, zero damping, missing/unknown phasor i niefinite wejścia/wyniki.
Browser validation panelu pozostaje osobną bramką; source test nie dowodzi UI.


Spectrum fallback Inspectora dopuszcza wyłącznie skończone liczby JSON lub
niepuste legacy numeric strings w polach modalnych f. `false`, `true`,
pusty tekst, null, tablica i obiekt nie są zerową częstotliwością ani zerowym
zanikiem. Regresja przechodzi przez rzeczywisty decoder spectrum do helpera
signed damping; pozostałe rodziny wykresów nie zmieniają parsera w tej korekcie.

| Source ID | Path | Symbol | Odpowiedzialność |
|---|---|---|---|
| source-r2-modal-frequency-decoder | apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts | readEigenSpectrumPayload | Strict modal frequency scalar admission przed fallbackiem Inspectora |


## R2 P2 - odczyt konfiguracji live factor przed eksperymentem

Kontrolowany pomiar z #38062145700 wykazal pelna zgodnosc jawnych wpisow
Pmat, lecz rozne residuale live PC i fresh MAT_SHIFT_NONE. Nie dowodzi to
przyczyny. Przed zmiana polityki live LU odczytujemy rzeczywista konfiguracje
faktora w istniejacym, bezpiecznym callbacku, jeszcze przed hard EPS error.
Pinned PETSc v3.24.6 udostepnia publiczne PCFactorGetShiftType i
PCFactorGetShiftAmount; wczesniejsze stale unavailable nie opisuje mozliwosci
tej wersji biblioteki. Uzywamy getterow tylko dla sprawdzonego PCLU.

Pola rozrozniaja requested/configured od queried live configuration. Odczyt
shift type i amount nie mierzy faktycznej perturbacji wpisow faktora: ten
osobny dowod pozostaje unavailable. Getter failure ma jawny error code i
null wartosci, bez przypisywania requested policy. Nie zmieniamy Pmat, RHS,
operatora, targetu, tolerancji, factor workspace ani kryteriow przyjecia modu.
Nie dodajemy zapytan po hard EPS error. Zasady cleanup/quarantine pozostaja.
Weryfikacja: serializer null/observed cases oraz hosted native live-PC
fixtures. SOURCE nie jest dowodem odczytu ani kwalifikacji fizyki.

[Zrodlo PETSc v3.24.6 - factor.c](https://github.com/petsc/petsc/blob/v3.24.6/src/ksp/pc/impls/factor/factor.c).

| Source ID | Path | Symbol | Responsibility |
|---|---|---|---|
| source-live-pmat-shift-query-r2 | backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp | PetscErrorCode prepare_candidate_owned_pmat_copy_and_lu | Query live PCLU shift configuration through pinned public getters before graph failure; never infer factor perturbation. |
| source-live-pmat-json-plan | backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp | std::string live_pc_observation_json | Preserve optional measured configuration and explicit unavailable/error states. |
