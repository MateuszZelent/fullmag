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
| $\mathbf u_{n\mathbf k}$ | periodic envelope of a full Bloch mode | $1$ |
| $C(\mathbf k)$ | complex constraint or prolongation map for full Bloch fields | $1$ |
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

Constraint construction operates on complete corner/edge equivalence classes
and checks cycle consistency. A phase-only tangent constraint is invalid for
varying frames.

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
may already be coercive. The original residual is evaluated after reconstructing
the full magnetic and potential fields, not only in reduced coordinates.

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

Here $k$ is the signed scalar component along $\hat{\mathbf z}$ and the
potential/fields are normalized per unit waveguide length. The $k\to0$ limit
must be compared against a separately assembled 2D magnetostatic operator;
it is not evidence that a 3D full-cell seam constraint can be removed. The
waveguide path is the planned S09 realization and remains unvalidated.

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
| Real-frequency SLEPc adapter | FEM CPU modal adapter | `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` + `solve_slepc_gyrotropic_modal_eigen_with_matrices` | Lift the real stiffness/gyrotropic pencil to $R(A)y=\omega R(\mathrm{i}G)y$, apply the signed shift on the physical frequency axis, and map the split vector back to the complex tangent mode. | source contract tested; managed runtime unvalidated |
| Floquet tangent source assembly | FEM CPU Floquet source | `backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp` + `assemble_floquet_bloch_scalar_tangent_source` | Assemble the magnetization-to-scalar-potential source element-locally, including the shifted-envelope $\mathrm{i}\mathbf{k}\cdot\mathbf{m}$ term and magnetic-element mask. This is a source assembly boundary, not a production nonzero-$k$ demag qualification. | source contract tested; managed assembly and physics unvalidated |
| CPU Schur selected spectrum | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Solve and certify the source-visible descriptor reduction. | source tested; managed qualification absent |
| GPU PETSc/SLEPc selected spectrum | FEM GPU | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Declare the GPU modal adapter. | source tested; device qualification absent |
| Modal payload ownership | common native | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `validate_native_modal_request_payload_ownership` | Reject ambiguous or missing operator payload ownership. | source tested; runtime unvalidated |
| Driven method fail-closed policy | common runner | `crates/fullmag-runner/src/frequency_response.rs` + `frequency_response_solver_method_rejection_reason` | Reject unavailable method/device combinations before fallback. | source tested |
| Native CPU driven boundary | FEM CPU | `crates/fullmag-runner/src/frequency_response.rs` + `try_execute_fem_frequency_response_native_production_cpu` | Build the native CPU response request and preserve explicit failure. | source tested; managed physics unvalidated |
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
- [ ] Nonzero-k dynamic demag and DMI managed-runtime and physics-qualified

(limitations)=
## 7. Known limits and deferred work

This note is a contract and claim freeze, not solver promotion. The real-axis
rotation, Poisson-airbox weak-form assembly, CPU Schur boundary, CPU
Floquet/airbox dynamic-demag path, GPU adapter and public requests are
source-visible, but current-snapshot managed qualification of finite descriptor
handling, production reduced response, device-resident Krylov, general GPU
modal eigensolve, damping/nonuniform textures and physical K0 demag remains
absent. Nonzero-k dynamic demag is gated as unqualified, nonzero-k DMI remains
unavailable, and fully 3D periodic demag remains unavailable; all unsupported
combinations fail closed.

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
| {eq}`eq-fem-modal-static-field-frame-transport` (source-static-field-frame-transport) | FEM CPU | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `FrequencyDomainStatus assemble_native_magnetic_a_qq` | Cross-node static-field tangent projection | Native covariance regression prepared, not compiled | source-visible / runtime NOT VERIFIED | working tree |
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
| Contract text regression | documentation | `scripts/test_frequency_domain_math_contract_docs.py` + `test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims` | Freeze canonical algebra, units, lane names and claim status. | same symbol | source tested; not numerical evidence | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/scripts/test_frequency_domain_math_contract_docs.py) |
| {eq}`eq-fem-full-bloch-ansatz`, {eq}`eq-fem-full-bloch-demag`, {eq}`eq-fem-full-bloch-weak` | FEM CPU/GPU planned | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` + `DOC-ANCHOR:full-bloch-operator-contract` | Freeze the 3D full Bloch field, ordinary-gradient demagnetization and weak-form boundary before production assembly. | S03/S04 and V0/V4 are pending | planned contract; no runtime evidence | repository note |
| {eq}`eq-fem-waveguide-envelope-demag` | FEM CPU/GPU planned | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` + `DOC-ANCHOR:waveguide-envelope-operator-contract` | Freeze the separate 2.5D waveguide envelope and shifted-gradient demagnetization equations. | S09/V5 pending | planned contract; no runtime evidence | repository note |
| Full Bloch tangent prolongation | FEM CPU planned | `backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp` + `class FloquetTangentProlongation` | Represent phase and tangent-frame transport for the interleaved local coefficients. | `fem_floquet_magnetic_operator_contract` source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated; not connected to solver ABI | repository source |
| Reduced full Bloch operator | FEM CPU planned | `backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp` + `class FloquetReducedMagneticOperator` | Define the matrix-free $C(\mathbf k)^\mathsf{H}AC(\mathbf k)$ boundary. | same focused contract test; no managed FEM run | source visible; uncompiled/unvalidated; not connected to solver ABI | repository source |
| Dynamic nonzero-k demagnetization oracle | FEM CPU source-visible | `backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp` + `build_floquet_dynamic_demag_k_real_split` | Provide the bounded dense Schur oracle for complex nonzero-k dynamic demagnetization; mesh assembly and production qualification remain separate. | `fem_floquet_dynamic_demag_k_contract` source is present; managed compile/runtime unvalidated | source visible; managed/physics unvalidated | repository source |
| MFEM Floquet airbox bridge | FEM CPU planned | `backends/fem/cpu/frequency_domain/floquet_airbox_operator.hpp` + `assemble_floquet_airbox_dynamic_demag_k` | Materialize bounded `C(k)^H P_full(k) C(k)` and `C(k)^H A_{phi q}` blocks, then delegate Schur elimination to the dynamic demag-k provider; production mesh assembly and capability promotion remain separate. | `fem_floquet_airbox_operator_contract` source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated | repository source |
| Waveguide nonzero-k demagnetization oracle | FEM CPU planned | `backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp` + `build_floquet_waveguide_demag_k_real_split` | Provide the bounded 2.5D modified-Helmholtz and Schur oracle; transverse MFEM assembly and open-boundary convergence remain separate. | `fem_floquet_waveguide_demag_k_contract` source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated | repository source |
| Existing shared-domain Poisson owner | FEM CPU | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` + `assemble_poisson_airbox_shared_domain` | Preserve the existing K0/shared-domain assembly boundary while nonzero-k demag remains gated. | existing source contract tests | source visible; nonzero-k physics unvalidated | repository source |


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

Powietrze ma niezależne płaszczyzny: pierwszy krok od interfejsu
wynika z minimum rozmiaru filmu i zadanej minimalnej wielkości powietrza,
następne rosną według `AirboxOptions.grading_ratio` do
`maximum_element_size`. Ostatni krok domyka rzeczywistą granicę airboxu.
Wszystkie wielkości wejściowe są w metrach; skalowanie GEO do mikrometrów
nie zmienia wyniku ani translacji Floqueta w artefaktach SI.

Ścieżka pierścienia zachowuje dotychczasowy podział; nowe stopniowanie
dotyczy Box. FDM CPU/GPU nie korzystają z tej siatki. Generacja FEM jest
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
| source-box-layer-generator | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_tetrahedral_box_airbox_mesh` |
| source-box-layer-routing | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_realize_fem_domain_mesh_asset_from_components_impl` |
| source-box-layer-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_public_de_model_shared_domain_realizes_six_layers` |

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
| source-box-lateral-regression | `scripts/test_box_layered_airbox_mesh.py` | `test_box_lateral_resolution_survives_final_air_fields` |


## Warstwy powietrza w periodycznej komórce antidot A1

Ekstruzja wspólnej domeny Box minus Cylinder musi realizować stopniowanie
powietrza w osi z przez jawne płaszczyzny, tak samo jak pełny film Box.
Samo pole rozmiaru Gmsh nie dzieli ekstruzji z jednym elementem na odcinek.
Dla geometric pierwszy krok wynosi min(hmax filmu, jawne minimum powietrza),
następne rosną przez grading_ratio do maximum_element_size; ostatni krok
kończy się dokładnie na zewnętrznej granicy Dirichleta. Film zachowuje n
jednakowych warstw. Zmiana n nie zmienia płaszczyzn zewnętrznego powietrza.
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
