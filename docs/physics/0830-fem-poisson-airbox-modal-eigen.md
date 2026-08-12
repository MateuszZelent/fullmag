# FEM Poisson-Airbox Modal Eigenproblem

- Status: FEM CPU and FEM GPU `source_visible / unvalidated`; public physical
  bias-field sweep, native MFEM assembly and two-pass window certificates are
  implemented at source level, but no current-snapshot managed CPU/GPU
  qualification is available
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-08-12
- Related physics notes:
  - `0700-frequency-domain-linearized-llg.md`
  - `0800-fem-static-pbc-demag.md`
  - `0828-fem-frequency-domain-floquet-demag.md`
  - `0831-fem-dynamic-pencil-modal-response-and-krylov.md`
  - `0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related implementation plan:
  - `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
- Related equilibrium-acceptance design:
  - `docs/superpowers/specs/2026-08-12-user-owned-relaxation-acceptance-for-eigensolve-design.md`

(problem-statement)=
## 1. Physical domain and problem statement

This note defines the first physically valid FEM modal eigensolve with dynamic
Poisson-airbox demagnetization. It is a `k=0`, alpha-zero, shared-domain
candidate around an accepted static equilibrium. The magnetic perturbation is
complex and tangent to the equilibrium; the scalar-potential perturbation lives
on the full magnetic-plus-airbox domain.

The topology-shaped PA-E1/PA-E4b payload is an algebraic test oracle only. It
is not a FEM Poisson-airbox model and must not be labeled production physics.

### Backend and device qualification boundary

| Solver | Device | Current state | Boundary |
|---|---|---|---|
| FEM | CPU | `source_visible / unvalidated` | The public sweep, ABI-v18 native P1 assembly, Schur solver and two-pass window certificate exist in source. No matching fresh managed runtime, physical K0-3 convergence or production evidence exists for this snapshot. |
| FEM | GPU | `source_visible / unvalidated` | The PETSc/SLEPc CUDA adapter and two-pass window certificate exist in source. Executed device residency, matrix-free convergence, parity, sanitizer, scaling and production evidence are open. |
| FDM | CPU | not applicable | FDM demagnetization has a separate canonical physics owner. |
| FDM | GPU | not applicable | FDM demagnetization has a separate canonical physics owner. |

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

Fullmag uses the $+\mathrm{i}\omega t$ convention and a tangent perturbation
$\delta\mathbf m=Tq$:

```{math}
:label: eq-poisson-airbox-modal-ansatz
\mathbf m(\mathbf r,t)=\mathbf m_0(\mathbf r)
 + \operatorname{Re}\!\left[\delta\mathbf m(\mathbf r)
   \exp(\mathrm{i}\omega t)\right],
\qquad
\delta\mathbf m=Tq,
\qquad
\mathbf m_0\cdot\delta\mathbf m=0,
\qquad
\delta\mathbf H_{\mathrm{demag}}=-\nabla\delta\phi .
```

With $\delta\mathbf M=M_s\delta\mathbf m$ in the magnetic region and zero in
the airbox, the scalar-potential problem on the shared domain
$D=\Omega_m\cup\Omega_{\mathrm{air}}$ is

In canonical ASCII notation, `D = Omega_m union Omega_air.` and
`delta_H_demag = -grad(delta_phi).`

```{math}
:label: eq-poisson-airbox-strong-form
\nabla\cdot\nabla\delta\phi
 = \nabla\cdot\delta\mathbf M
\quad\text{in }D,
\qquad
\delta\mathbf M=
\begin{cases}
M_s\delta\mathbf m,&\mathbf r\in\Omega_m,\\
0,&\mathbf r\in\Omega_{\mathrm{air}}.
\end{cases}
```

For a Robin approximation on the open exterior boundary
$\Gamma_{\mathrm{open}}$, the implemented weak form is

```{math}
:label: eq-poisson-airbox-weak-form
\int_{D}\nabla\psi\cdot\nabla\delta\phi\,\mathrm{d}V
 + \beta\int_{\Gamma_{\mathrm{open}}}\psi\,\delta\phi\,\mathrm{d}S
 = \int_{\Omega_m} M_s\,\delta\mathbf m\cdot\nabla\psi\,\mathrm{d}V .
```

The Robin term is excluded from periodic cuts. Dirichlet eliminates the
corresponding potential DOFs. Pure Neumann has a constant nullspace and alone
uses a mean-zero gauge. Fully periodic three-dimensional k=0 demagnetization
is unsupported until a macroscopic-field convention is defined.

```{math}
:label: eq-poisson-airbox-modal-block
\begin{aligned}
A_{qq}q+A_{q\phi}\phi &= \lambda B_{qq}q,\\
A_{\phi q}q+P\phi &= 0,\\
L_{\mathrm{eff}}q &= \lambda B_{qq}q,\qquad
L_{\mathrm{eff}}=A_{qq}-A_{q\phi}P^{-1}A_{\phi q},\\
\lambda&=\mathrm{i}\omega .
\end{aligned}
```

```{math}
:label: eq-poisson-airbox-coupling-signs
C_{\phi q}q
=\int_{\Omega_m}M_s(Tq)\cdot\nabla\psi\,\mathrm{d}V,
\qquad
A_{\phi q}=-C_{\phi q},
\qquad
A_{q\phi}=-\mu_0A_{\phi q}^{\mathsf T}
=\mu_0C_{\phi q}^{\mathsf T}.
```

For a pure-Neumann scalar block, the second row is augmented by $c\eta$ and
$c^{\mathsf T}\phi=0$. Robin and Dirichlet have no `eta` row.

The acceptance residuals are computed from the original, unscaled descriptor:

```{math}
:label: eq-poisson-airbox-full-residuals
\begin{aligned}
r_q&=A_{qq}q+A_{q\phi}\phi-\lambda B_{qq}q,\\
r_\phi&=A_{\phi q}q+P\phi+c\eta,\\
r_g&=c^{\mathsf T}\phi,\\
\epsilon_q&=\frac{\lVert r_q\rVert_2}
 {\lVert A_{qq}q\rVert_2+\lVert A_{q\phi}\phi\rVert_2
 +|\lambda|\lVert B_{qq}q\rVert_2+\delta_q},\\
\epsilon_\phi&=\frac{\lVert r_\phi\rVert_2}
 {\lVert A_{\phi q}q\rVert_2+\lVert P\phi\rVert_2
 +\lVert c\eta\rVert_2+\delta_\phi},\\
\epsilon_g&=\frac{|c^{\mathsf T}\phi|}
 {\lVert c\rVert_2\lVert\phi\rVert_2+\delta_g}.
\end{aligned}
```

The positive floors are block-specific representation constants:
$\delta_q$, $\delta_\phi$ and $\delta_g$ have the same units as their
respective denominators. They are not one dimensionless physical constant.

The managed real-scalar PETSc/SLEPc contract targets the imaginary-axis
eigenvalue through the named real-frequency rotation:

```{math}
:label: eq-poisson-airbox-rotated-pencil
\mathcal R(L)y=\omega\,\mathcal R(\mathrm{i}B_\alpha)y,
\qquad
\tau=\omega_{\mathrm{target}},
\qquad
\lambda=\mathrm{i}\omega .
```

The thin-film Kittel relation is an independent postsolve oracle, never an
assembly, equilibrium, target or acceptance input:

```{math}
:label: eq-poisson-airbox-kittel-oracle
\omega_{\mathrm{Kittel}}^2
=\gamma_0^2H_b\!\left(H_b+M_{\mathrm{eff}}\right),
\qquad
f_{\mathrm{Kittel}}=\frac{\omega_{\mathrm{Kittel}}}{2\pi}.
```

The relaxation stage, not eigensolve, owns physical equilibrium acceptance:

```{math}
:label: eq-poisson-airbox-user-owned-equilibrium-acceptance
g_{\mathrm{stop}}(\mathbf m_0)\leq\tau_{\mathrm{stop}},
\qquad
g_{\mathrm{stop}}\in
\left\{\max_{\Omega_m}|\mathbf m_0\times\mathbf H_{\mathrm{eff},0}|,
\Delta E\right\},
\qquad
\rho_\tau=
\frac{\max_{\Omega_m}|\mathbf m_0\times\mathbf H_{\mathrm{eff},0}|}
{\max\!\left(\max_{\Omega_m}|\mathbf H_{\mathrm{eff},0}|,
1\,\mathrm{A\,m^{-1}}\right)}.
```

The recorded criterion may therefore be torque or energy. The relative torque
$\rho_\tau$ is retained for diagnosis only; it has no default acceptance
threshold and cannot reverse a completed relaxation stage. An imported state
must carry an equivalent immutable acceptance certificate.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf r$ | spatial position | $\mathrm{m}$ |
| $t$ | time | $\mathrm{s}$ |
| $\mathbf m$, $\mathbf m_0$, $\delta\mathbf m$ | normalized magnetization, accepted equilibrium and tangent perturbation | $1$ |
| $T$ | tangent-frame map from modal coefficients to $\delta\mathbf m$ | $1$ |
| $q$ | tangent-plane modal coefficients | $1$ |
| $\delta\mathbf M$ | dynamic magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\delta\mathbf H_{\mathrm{demag}}$ | dynamic demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\delta\phi$, $\phi$ | dynamic scalar magnetic potential and its coefficient vector | $\mathrm{A}$ |
| $\psi$ | scalar-potential test function | $1$ |
| $D$, $\Omega_m$, $\Omega_{\mathrm{air}}$ | shared, magnetic and airbox domains | $\mathrm{m^3}$ |
| $\Gamma_{\mathrm{open}}$ | open exterior boundary | $\mathrm{m^2}$ |
| $\mathrm{d}V$, $\mathrm{d}S$ | volume and surface measures | $\mathrm{m^3}$, $\mathrm{m^2}$ |
| $\nabla$ | spatial gradient | $\mathrm{m^{-1}}$ |
| $\operatorname{Re}$, $\exp$, $\mathrm{i}$, $(\cdot)^\ast$ | real-part map, exponential, imaginary unit and complex conjugation; the operators/constants are dimensionless and preserve or combine operand units as written | $1$ |
| $\lVert\cdot\rVert_2$, $|\cdot|$ | Euclidean norm and absolute value; each result inherits the operand unit | $1$ |
| $(\cdot)^{\mathsf T}$, $\cdot$ | transpose and Euclidean contraction; the operators are dimensionless | $1$ |
| $\int$, $\cup$, $\nabla\cdot$ | integration, set union and divergence operators; dimensional changes come from the measure or derivative shown in the equation | $1$ |
| $\pi$ | circle constant | $1$ |
| $\min$, $\max$, $\lfloor\cdot\rfloor$, $\lceil\cdot\rceil$ | selection and integer-rounding operators used by the deterministic window schedule | $1$ |
| $\beta$ | Robin coefficient | $\mathrm{m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{T\,m\,A^{-1}}$ |
| $P$ | scalar Poisson stiffness block | $\mathrm{m}$ |
| $C_{\phi q}$, $A_{\phi q}$ | magnetic-to-potential coupling blocks | $\mathrm{A\,m}$ |
| $A_{q\phi}$ | potential-to-magnetic coupling block | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $A_{qq}$ | magnetic restoring block | $\mathrm{m^3\,s^{-1}}$ |
| $B_{qq}$, $B_\alpha$ | tangent mass and damped gyrotropic mass blocks | $\mathrm{m^3}$ |
| $L_{\mathrm{eff}}$, $L$ | Schur-reduced and full magnetic operators | $\mathrm{m^3\,s^{-1}}$ |
| $\lambda$ | modal eigenvalue | $\mathrm{s^{-1}}$ |
| $\omega$, $\omega_{\mathrm{target}}$, $\tau$ | angular frequency, requested angular target and rotated-pencil target | $\mathrm{rad\,s^{-1}}$ |
| $\mathcal R(\cdot)$, $y$ | real-split operator and real-split state | $1$ |
| $c$, $\eta$ | mean-zero gauge vector and Lagrange multiplier | $\mathrm{m^3}$, $\mathrm{A\,m^{-2}}$ |
| $r_q$, $r_\phi$, $r_g$ | magnetic, scalar and gauge residuals | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $\epsilon_q$, $\epsilon_\phi$, $\epsilon_g$ | normalized magnetic, scalar and gauge residuals | $1$ |
| $\delta_q$, $\delta_\phi$, $\delta_g$ | positive magnetic, scalar and gauge denominator floors | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $H_b$, $M_{\mathrm{eff}}$ | physical bias-field magnitude and effective magnetization used only by the Kittel oracle | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | $\mu_0|\gamma|$ gyromagnetic factor in the A/m convention | $\mathrm{rad\,s^{-1}\,(A\,m^{-1})^{-1}}$ |
| $f_{\mathrm{Kittel}}$ | Kittel oracle frequency | $\mathrm{Hz}$ |
| $\Delta f$, $f_{\min}$, $f_{\max}$, $f_a$, $f_b$ | window width, bounds and candidate frequencies | $\mathrm{Hz}$ |
| $U$, $V$, $u_i$, $v_j$ | orthonormal cluster bases and vectors | $1$ |
| $i$, $j$, $r$ | cluster-basis indices and paired cluster rank | $1$ |
| $u_i^\ast v_j$, $s(U,V)$ | Hermitian overlap and normalized invariant-subspace overlap | $1$ |
| $\mathbf H_{\mathrm{eff},0}$ | effective field evaluated at the accepted equilibrium | $\mathrm{A\,m^{-1}}$ |
| $g_{\mathrm{stop}}$ | user-authored relaxation stop metric | metric-dependent: $\mathrm{A\,m^{-1}}$ or $\mathrm{J}$ |
| $\tau_{\mathrm{stop}}$ | user-authored relaxation stop threshold | same as $g_{\mathrm{stop}}$ |
| $\rho_\tau$ | relative torque diagnostic, never an eigensolve acceptance threshold | $1$ |

(assumptions-and-validity)=
### 2.3 Assumptions and validity limits

- $\mathbf m_0$ originates in an accepted relaxation handoff or certified
  equilibrium artifact with matching mesh, material, physics and boundary
  signatures. Acceptance is owned by the user's completed relaxation stop
  contract; eigensolve does not impose an additional relative-torque limit.
- A completed relaxation is accepted when its recorded torque or energy metric
  satisfies the corresponding authored threshold. `max_steps`, time limits,
  cancellation and backend failure do not establish equilibrium.
- Relative torque remains a diagnostic observable and cannot override a
  completed, converged relaxation stage.
- The source-level native magnetic producer supports P1 `tet4` and `prism6`
  magnetic elements, one homogeneous scalar $A_{\mathrm{ex}}$, accepted
  tangent frames, positive $M_s$, a static restoring field parallel to
  $\mathbf m_0$, and dynamic-demag provenance bound to the operator-input
  digest. Anisotropy and DMI return `unavailable`.
- The requested modal scope is exact $k=0$, $\alpha=0$, double precision,
  x/y-periodic and open-z, with `spin_wave_bc="periodic"` and
  `magnetostatic_bc="periodic_airbox_k0"`.
- Nonzero-k dynamic demag requires complex Bloch `grad_k/div_k` assembly and is
  not approximated by the k=0 operator.
- The exact shifted-preconditioner/materialized baseline is bounded to a
  real-split descriptor dimension of at most 1024 and is an oracle for
  validation, not the production-size definition.
- Canonical scope vocabulary is literal: **materialized descriptor dimension
  <= 1024 is validation_only**; the production operator kind is
  `matrix_free_schur_selected_spectrum`; **production qualification requires a
  measured operator_dimension > 1024**.

### 2.4 Exact qualification scopes

These IDs freeze the intended qualification envelopes; they are not
`validated_scope` values until the corresponding managed gates pass.

| Scope ID | Exact envelope | Current evidence |
|---|---|---|
| `modal_cpu_k0_periodic_airbox_real_shared_domain.production` | FEM CPU; P1 `tet4|prism6` shared magnetic/airbox mesh; one homogeneous scalar $A_{\mathrm{ex}}$; exchange, accepted parallel static restoring field and dynamic Poisson-airbox demag; x/y periodic, open z; Robin outer boundary with no gauge or pure Neumann with mean-zero gauge; exact Gamma; $\alpha=0$; double; `full_2x2`; real-frequency rotated target; three-to-five-sample physical `BiasFieldSweep`; production `matrix_free_schur_selected_spectrum` with a measured operator dimension greater than 1024 | Future catalog binding only; `source_visible / unvalidated`; `validated_scope=null`, `executable_scope=null` |
| `modal_gpu_k0_periodic_airbox_scalable.production` | Same physics, geometry, BC/gauge, precision, target and sweep as CPU; PETSc/SLEPc CUDA `matrix_free_schur_selected_spectrum`, persistent device solver state, no permitted CPU fallback, and a measured operator dimension greater than 1024 | Future catalog binding only; `source_visible / unvalidated`; `validated_scope=null`, `executable_scope=null` |

The materialized CPU and GPU descriptors at dimensions up to and including
1024 remain validation-only evidence. They may exercise algebra, signs,
window certification and parity, but they cannot satisfy either production
binding and cannot promote readiness or capability state.

## 3. Solver family and numerical interpretation

(discrete-realization)=

### 3.1 FEM

`P`, `C_{\phi q}`, potential feedback, `B_{qq}` and `A_{qq}` are assembled
against one accepted MFEM mesh/space and tangent-frame source. The selected
spectrum solve is Schur reduced, with the original descriptor reconstructed
for certification.

ABI v18 deliberately does not carry a preassembled `A_qq`.
`assemble_native_magnetic_a_qq` owns the magnetic block on the native MFEM
mesh. It assembles the P1 exchange weak form for `tet4|prism6` and the accepted
parallel-field restoring block. Anisotropy and DMI fail closed as
`unavailable`. A DEMAG presence bit is accepted only with a provider signature
equal to the operator-input digest; the dynamic response remains in
`A_{q\phi}P^{-1}A_{\phi q}` rather than becoming a duplicate local `A_qq`
term. `assemble_poisson_airbox_shared_domain_payload` imports this descriptor
and `assemble_poisson_airbox_shared_domain` owns the complete shared-domain
block assembly.

Consequently, the demagnetizing contribution to the energy Hessian is
positive semidefinite. For an in-plane, x/y-periodic thin film, the uniform
out-of-plane tangent component receives the `+Ms` restoring stiffness while
the uniform in-plane component does not. Reversing the `A_qphi` sign produces
`H0-Ms`, a real unstable eigenvalue, and must fail the reciprocal-coupling and
K0-3 Kittel gates.

The accepted full residual is
`max(epsilon_q, epsilon_phi, epsilon_g)` from
{eq}`eq-poisson-airbox-full-residuals` and is not
replaced by a smaller backend-reported residual.

The managed runtime is the real-scalar `libpetsc-real-dev` plus
`libslepc-real-dev` lane. It represents the complex target
`sigma=i omega_target` only with the ADR-017 real-split
`real_frequency_rotated` pencil in {eq}`eq-poisson-airbox-rotated-pencil`.

`EPSSetTarget(tau)` is legal only on that named rotated pencil. A real scalar
target `omega_target` on the original `lambda=i omega` pencil is invalid and
must reject rather than approximate the imaginary-axis target.

For `target="frequency_window"`, the CPU Schur realization uses the
deterministic certificate `shift_nev_refinement_subspace_v1`. The base pass
retains the 16 midpoint shifts. The refinement pass uses 32 half-step-shifted
partitions plus one guard shift on each side of the requested interval:

```{math}
:label: eq-poisson-airbox-window-refinement-schedule
\Delta f=\frac{f_{\max}-f_{\min}}{32}, \qquad
\left[f_{\min}-\frac{\Delta f}{2},\,
      f_{\max}+\frac{\Delta f}{2}\right].
```

Both reported edge-coverage margins therefore equal $\Delta f/2$ and must be
strictly positive. The refinement
nearest-frequency requests twice the requested mode count, subject to the same
descriptor-dimension guard; its resolved `nev` must be greater than the base
`nev`.

Every nearest-frequency subsolve must return `ok`, and every accepted candidate
must already pass the full original, unscaled descriptor residual described
above. Accepted frequencies are clustered with tolerance
$\max(1\,\mathrm{Hz},10^{-8}\max(|f_a|,|f_b|))$. Within each cluster,
the magnetic $q$ components are reorthogonalized to determine rank. Given
orthonormal bases $U=\{u_i\}_{i=1}^{r}$ and
$V=\{v_j\}_{j=1}^{r}$ for equal-rank base and refinement clusters, the
reported invariant-subspace overlap uses the Hermitian inner product
$u_i^{\ast}v_j$:

```{math}
:label: eq-poisson-airbox-window-subspace-overlap
s(U,V)=\left(\frac{1}{r}\sum_{i=1}^{r}\sum_{j=1}^{r}
\left|u_i^{\ast}v_j\right|^2\right)^{1/2}.
```

The window is certified only when both schedules complete without failure or
cancellation, the requested mode count is covered without splitting a
degenerate cluster, paired clusters have stable frequencies and ranks,
$\min s(U,V)\ge 1-10^{-6}$, both edge margins are positive, and neither schedule
nor cluster JSON is truncated. A disagreement returns `solve_error`, keeps
`window_complete=false`, publishes
`frequency_window_refinement_disagreement`, and records a non-certified
certificate. When the requested count would split a residual-certified
cluster, that offending cluster frequency and rank remain visible in the
certificate even though `accepted_mode_count` is zero. Cancellation remains
`interrupted` with `cancel_requested`.

### 3.2 GPU

A GPU result can become production-capable only when the assembled blocks,
vectors, Krylov basis and preconditioner remain resident on the device through
the full selected-spectrum iteration. Source contains a PETSc/SLEPc CUDA
adapter with `seqaijcusparse` matrices, `seqcuda` vectors, a device Schur
operator and fail-closed no-CPU-fallback policy. This snapshot has no matching
fresh ABI-v18 managed execution, so these are source claims only.
For `target="frequency_window"`, the source-level GPU adapter uses the same
16-midpoint base schedule and 32-half-step plus two-guard refinement schedule
as the CPU lane. It compares q-space cluster ranks and invariant-subspace
overlap, requires positive edge-coverage margins, and fails closed on a failed
subwindow, cancellation, truncation, or refinement disagreement. This
source-level certificate does not by itself prove runtime execution or GPU
residency.
The source-level materialized path is bounded through 1024 descriptor
dimensions and is validation-only. Larger problems select the explicit
matrix-free shell, but
convergence, persistent EPS/ST/KSP/BV ownership, allocation/transfer telemetry,
scaling and sanitizer evidence remain open. One-shot `A*x` or dense
inverse-iteration contracts are not a device-resident modal solver.

### 3.3 FDM CPU and GPU

FDM CPU/GPU are not realizations of this FEM Poisson-airbox note. Their
demagnetization kernels and FFT/Newell boundary semantics are documented by the
FDM interaction owner; no FDM capability is inferred from the FEM results.

### 3.4 FDM and hybrid

This note does not alter FDM demagnetization or introduce hybrid semantics.

(python-api)=
## 4. Python API

The public API is stage-first and physics-first. This complete authoring
example declares the shared domain, x/y periodicity with open z, an explicit
relax stage, the physical three-sample bias sweep, `full_2x2`, exact Gamma and
an independent postsolve Kittel oracle. It requests CPU; changing the requested
device to `"cuda"` preserves the same physical intent but does not turn the
unvalidated GPU lane into a qualified one.

```python
# %%
import math

import fullmag as fm

mu0 = 4.0e-7 * math.pi
bias_samples_a_per_m = [
    (20.0e-3 / mu0, 0.0, 0.0),
    (50.0e-3 / mu0, 0.0, 0.0),
    (100.0e-3 / mu0, 0.0, 0.0),
]

# %%
study = fm.study("k0_periodic_airbox_bias_sweep")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %%
study.universe(mode="manual", size=(1200e-9, 600e-9, 550e-9))
film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.0
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.save("spectrum")

# %%
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="projected_gradient_bb",
    tolT=1.0e-6,
    max_steps=50_000,
)

# %%
study.stages.add_eigenmodes(
    count=4,
    target="frequency_window",
    frequency_min=1.0e6,
    frequency_max=5.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="periodic",
    magnetostatic_bc="periodic_airbox_k0",
    bias_field_sweep=fm.BiasFieldSweep(
        samples_a_per_m=bias_samples_a_per_m,
        equilibrium_policy="continuation",
        continuation_seed="previous_accepted_equilibrium",
    ),
)

# %%
result = study.run()
```

The code block parses with the current public constructors. The canonical
`Eigenmodes.to_ir()` lowering and CPU/CUDA script round-trip are covered by
`test_eigenmodes_bias_field_sweep_serializes_declared_si_samples` and
`test_study_stage_builder_bias_field_sweep_roundtrips_cpu_and_gpu_intent`.
The executable example deliberately does not install
`K0KittelFieldSweepValidation`: the current runner rejects that metadata when
`BiasFieldSweep` is present with
`bias_field_sweep_kittel_postsolve_oracle_unavailable`. A future per-sample
postsolve adapter may compare the completed spectra with
{eq}`eq-poisson-airbox-kittel-oracle`, but it may not feed the physical request.
The final `study.run()` then still requires a matching managed runtime and is
not claimed GREEN by this documentation update.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `study.device(spec, precision=...)` | `str`, `str` | required, optional | $1$ | this scope requires explicit `cpu` or `cuda` and `double` | requested execution intent | FEM CPU/GPU source contract; no hidden fallback | `backend_policy` and runtime metadata |
| `study.mode("strict")` | `str` | required by this scope | $1$ | sweep rejects non-strict execution | fail-closed capability policy | FEM CPU/GPU source contract | `validation_profile.execution_mode` |
| `study.pbc(x, y, z, demag)` | `bool, bool, bool, str` | `False, False, False, "open"` | $1$ | sweep requires x/y `True`, z `False` and `periodic_airbox_k0` | problem periodicity and static demag policy | FEM CPU/GPU source contract | `pbc.axes`, `pbc.demag` |
| `relax.tolA` | `float or None` | public relaxation default when omitted | $\mathrm{A\,m^{-1}}$ | finite and positive; mutually exclusive with tolT | authored torque stop threshold | FEM CPU/GPU relaxation contract | `StudyIR::Relaxation.stop.torque_tolerance_apm` |
| `relax.tolT` | `float or None` | public relaxation default when omitted | $\mathrm{T}$ | finite and positive; mutually exclusive with tolA | authored torque stop threshold normalized through mu0 | FEM CPU/GPU relaxation contract | `StudyIR::Relaxation.stop.torque_tolerance_apm` |
| `relax.energy_tolerance` | `float or None` | `None` | $\mathrm{J}$ | finite and non-negative | authored energy stop threshold that can independently certify relaxation | FEM CPU/GPU relaxation contract | `StudyIR::Relaxation.stop.energy_tolerance_j` |
| relaxation completion | stage result | generated | metric-dependent | `completed`, `converged`, finite metric and `metric_value <= threshold`; max steps/time/cancel/error reject | sole physical acceptance input for following eigensolve | FEM CPU/GPU shared runtime contract | `StageCompletionIR`, immutable handoff provenance |
| `eigenmodes.count` | `int` | `10` | $1$ | `count > 0` | selected mode count | FEM CPU/GPU source contract | `study.count` |
| `eigenmodes.target` | `str` | `"lowest"` | $1$ | `lowest`, `nearest`, or `frequency_window` | spectral selection strategy | FEM CPU/GPU source contract | `study.target` |
| `eigenmodes.target_frequency` | `float or None` | `None` | $\mathrm{Hz}$ | finite and positive for `nearest` | nearest target frequency | FEM CPU/GPU source contract | `study.target.frequency_hz` |
| `eigenmodes.frequency_min` / `eigenmodes.frequency_max` | `float or None` | `None` | $\mathrm{Hz}$ | finite, positive and strictly ordered for `frequency_window` | requested interval | FEM CPU/GPU source contract | `study.target.frequency_min_hz` / `study.target.frequency_max_hz` |
| `eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2`; C1 scope requires `full_2x2` | linearized dynamics operator | FEM CPU/GPU source contract | `study.operator.kind` |
| `eigenmodes.include_demag` | `bool` | `True` | $1$ | sweep requires `True` and a demag energy term | dynamic demagnetizing feedback | FEM CPU/GPU source contract | `study.operator.include_demag` |
| `eigenmodes.equilibrium_source` | `str` | `"relax"` | $1$ | `relax`, `provided` or `artifact` | source of accepted equilibrium | FEM CPU/GPU source contract | `study.equilibrium` |
| `eigenmodes.equilibrium_artifact` | `str or None` | `None` | $1$ | required for `artifact` | accepted equilibrium path | FEM CPU/GPU source contract | `study.equilibrium.path` |
| `eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | mode normalization | FEM CPU/GPU source contract | `study.normalization` |
| `eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | C1 sweep requires `ignore` and material $\alpha=0$ | damping treatment | FEM CPU/GPU source contract | `study.damping_policy` |
| `eigenmodes.k_vector` / `eigenmodes.k_sampling` | 3-vector / object | `None` | $\mathrm{m^{-1}}$ | use one representation only; sweep requires one exact Gamma sample | wave-vector request | FEM CPU/GPU source contract at K0 | `study.k_sampling` |
| `eigenmodes.bc` | `str or dict` | `"free"` | $1$ | `periodic_airbox_k0` requires periodic spin-wave BC | exchange/spin-wave boundary policy | FEM CPU/GPU source contract | `study.spin_wave_bc` |
| `eigenmodes.magnetostatic_bc` | `str` | `"open"` | $1$ | sweep requires `periodic_airbox_k0` | scalar-potential boundary policy | FEM CPU/GPU source contract | `study.magnetostatic_bc` |
| `BiasFieldSweep.samples_a_per_m` | sequence of 3-vectors | required | $\mathrm{A\,m^{-1}}$ | non-empty; every component finite | authored physical bias field per sample | FEM CPU/GPU source contract | `study.bias_field_sweep.samples_a_per_m` |
| `BiasFieldSweep.equilibrium_policy` | `str` | `"relax_each"` | $1$ | `relax_each` or `continuation` | equilibrium policy per physical sample | FEM CPU/GPU source contract | `study.bias_field_sweep.equilibrium_policy` |
| `BiasFieldSweep.continuation_seed` | `str` | `"initial_state"` | $1$ | `previous_accepted_equilibrium` or `initial_state`; `relax_each` rejects previous seed | continuation seed provenance | FEM CPU/GPU source contract | `study.bias_field_sweep.continuation_seed` |
| generated sweep ordering | `str` | `"declared"` | $1$ | any other value rejects in `ProblemIR` | preserves authored sample order | FEM CPU/GPU source contract | `study.bias_field_sweep.ordering` |

(problem-ir)=
## 5. ProblemIR, planning, and provenance

The Python fields lower to one canonical `StudyIR::Eigenmodes` object. The
following JSON is the exact current `fm.Eigenmodes(...).to_ir()` result for the
modal stage in the example:

```json
{
  "kind": "eigenmodes",
  "dynamics": {
    "kind": "llg",
    "gyromagnetic_ratio": 221100.0,
    "integrator": "auto",
    "fixed_timestep": null
  },
  "operator": {"kind": "full_2x2", "include_demag": true},
  "count": 4,
  "target": {
    "kind": "frequency_window",
    "frequency_min_hz": 1000000.0,
    "frequency_max_hz": 5000000000.0
  },
  "equilibrium": {"kind": "relaxed_initial_state"},
  "k_sampling": {
    "kind": "single",
    "k_vector": [0.0, 0.0, 0.0]
  },
  "normalization": "unit_l2",
  "damping_policy": "ignore",
  "spin_wave_bc": "periodic",
  "magnetostatic_bc": "periodic_airbox_k0",
  "sampling": {
    "outputs": [{
      "kind": "eigen_spectrum",
      "quantity": "eigenfrequency",
      "scope": "per_sample"
    }]
  },
  "bias_field_sweep": {
    "samples_a_per_m": [
      [15915.494309189535, 0.0, 0.0],
      [39788.735772973836, 0.0, 0.0],
      [79577.47154594767, 0.0, 0.0]
    ],
    "equilibrium_policy": "continuation",
    "ordering": "declared",
    "continuation_seed": "previous_accepted_equilibrium"
  }
}
```

The enclosing `ProblemIR` additionally carries x/y periodic and open-z
`pbc.axes`, `pbc.demag="periodic_airbox_k0"`, strict execution, double
precision, material $\alpha=0$, and the exchange/demag energy terms. Canonical
validation rejects any sweep that loses those fields.

### 5.1 Python-to-IR and planner mapping

Normalization retains exact Gamma, `include_demag=true`, all physical
`samples_a_per_m`, equilibrium policy, continuation seed and declared ordering.
Planning adds resolved execution and provenance without rewriting that physical
request:

```text
requested: engine=fem, device=cpu|cuda, precision=double, mode=strict,
           operator=full_2x2, k=(0,0,0), include_demag=true,
           bias_field_sweep.samples_a_per_m=[...]
resolved:  solver_adapter=k0_poisson_airbox_cpu_schur_slepc
           or k0_poisson_airbox_gpu_petsc_slepc,
           algebraic_form=schur_reduced_descriptor,
           spectral_transform=shift_invert,
           spectral_scalar_mode=real_split,
           assembly_kind=mfem_weak_form_shared_domain
```

`BiasFieldSweepIR` is the physics-owned request. The planner creates one
sample plan per declared field and preserves requested and resolved execution
for each sample. `execute_bias_field_sweep` performs the sample lifecycle,
including `relax_each` or continuation from the explicitly selected seed.
`validate_bias_field_sweep_oracle_contract` prevents analytical Kittel metadata
from becoming a field, equilibrium, target or solve-acceptance input.

### 5.2 Native and artifact provenance

The native modal payload carries:

```text
frequency_domain_abi_version = 18
assembly_kind = mfem_weak_form_shared_domain | synthetic_algebraic_oracle
outer_boundary_kind = poisson_robin | poisson_dirichlet | pure_neumann
gauge_policy = none | mean_zero_augmented
gauge_reason = coercive_outer_boundary | pure_neumann_nullspace
spectral_scalar_mode = complex | real_split
sigma_real_per_s, sigma_imag_rad_per_s
```

The boundary, gauge, and reason form one validated tuple. `poisson_robin` and
`poisson_dirichlet` require `gauge_policy=none` and
`gauge_reason=coercive_outer_boundary`; `pure_neumann` requires
`gauge_policy=mean_zero_augmented`, normalized quadrature-assembled mean
weights, and `gauge_reason=pure_neumann_nullspace`. Synthetic PA-E1/PA-E4b
payloads remain algebra-only and cannot establish a production claim.

`eigen/field_sweep.v1.json` uses the writer-owned axis name
`scan_axis.coordinate="bias_field_a_per_m"` and sample value
`bias_field_a_per_m`, both in `A/m`. The display conversion is named `mu0_H`
and uses tesla. `external_field_a_per_m` is a spectrum/runtime diagnostic from
which the writer reads the physical sample; it is not the field-sweep axis
name.

`k0_kittel_validation` remains postsolve metadata only. It may compare the
solved physical samples with {eq}`eq-poisson-airbox-kittel-oracle`, but must not
change the authored field, assembled blocks, equilibrium, target, lane, status
or signatures.

### 5.3 Current ABI and managed-runtime status

The C1 audit snapshot is HEAD
`fe73ad661c55cc490faf076eb88f9ba387a9ac01` plus dirty source changes. Public
modal ABI is v18. The last inspected active managed bundle was built from
`dab10a48e9c4a49561610a7481d201d02b1e1c11`, 140 commits behind this HEAD, and
did not publish matching ABI-v18 evidence for the dirty snapshot. Managed
export lock files are present. This establishes a source/bundle/ABI evidence
mismatch and a missing fresh managed proof; it does not establish the host-wide
owner of a lock or the true mount write permissions. Neither CPU nor GPU is
promoted beyond `source_visible / unvalidated`.

(round-trip-and-failure-semantics)=
## 6. Round-trip and failure semantics

Script export reproduces the stage-first Python fields and their canonical
`ProblemIR` destinations. The exported request must preserve requested intent;
the runtime report separately records resolved execution, solver adapter,
device ownership, transfer audit, and artifact provenance. This separation is
required for reproducibility and for comparing CPU and GPU runs.

Validation errors are fail-closed. The planner rejects missing accepted
equilibrium fields, a missing shared-airbox periodic certificate, an invalid
boundary/gauge tuple, a nonzero k-vector in the K0 lane, a real target applied
to the unrotated imaginary-axis pencil, or a request for an unavailable
device-resident realization. Unsupported combinations are reported with the
requested fields and the resolved capability reason; they do not silently
select CPU, synthetic algebra, or a different demagnetization boundary.

Any artifact with `assembly_kind=synthetic_algebraic_oracle` must carry
`production_periodic_airbox_claim=false`. Production-labelled periodic-airbox
verification requires `assembly_kind=mfem_weak_form_shared_domain` and matching
managed assembly and physics evidence.

(implementation-mapping)=
## 7. Implementation and evidence mapping

| Contract | Stable source owner | Test/evidence boundary |
|---|---|---|
| Public physical sweep | `packages/fullmag-py/src/fullmag/model/eigen.py` + `BiasFieldSweep` | Python constructor and round-trip tests; no solve qualification |
| Canonical sweep IR and legality | `crates/fullmag-ir/src/study.rs` + `BiasFieldSweepIR`; `crates/fullmag-ir/src/lib.rs` + `ProblemIR::validate` | IR rejection tests for exact Gamma, double, strict, demag and x/y-periodic/open-z |
| Per-sample execution and Kittel separation | `crates/fullmag-runner/src/fem_eigen.rs` + `execute_bias_field_sweep` and `validate_bias_field_sweep_oracle_contract` | Runner lifecycle/oracle-isolation unit tests; no managed CPU/GPU proof |
| ABI-v18 native magnetic block | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `assemble_native_magnetic_a_qq` | Native MFEM source tests for P1 `tet4|prism6` exchange, field, unsupported anisotropy/DMI and demag identity |
| Shared-domain import and assembly | same path + `assemble_poisson_airbox_shared_domain_payload` and `assemble_poisson_airbox_shared_domain` | Native shared-domain source tests; no current-snapshot runtime promotion |
| CPU Schur and two-pass window | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Focused synthetic certificate tests; source evidence only |
| GPU PETSc/SLEPc, persistent state and Schur application | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`, `create_gpu_solver_state` and `apply_schur` | Focused synthetic GPU adapter tests; no fresh device execution or production scaling proof |
| Native diagnostics and eigen-v2 artifact writer | `crates/fullmag-runner/src/fem_eigen.rs` + `native_solver_diagnostics_json` and `write_eigen_v2_bundle` | Source serialization contracts; no managed-runtime or scientific qualification implied |
| Diagnostics and mode-field API resources | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` + `get_frequency_domain_eigen_diagnostics_v2` and `get_frequency_domain_eigen_mode_field_meta` | API source contracts; native browser evidence remains open |
| Results Inspector mode-field resource | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` + `EigenModeFieldResourceInspectorPanel` | React source/tests only; no native browser qualification |
| Unified viewport mode-field overlay | `apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts` + `class ModeFieldOverlayIntentController` | Controller source/tests only; no WebGL/runtime qualification |
| Field-sweep artifact axis | `crates/fullmag-runner/src/eigen/artifacts.rs` + `field_sweep_axis` | Writer emits `bias_field_a_per_m` and `mu0_H`; verifier consistency is a separate gate |

## 8. Discrete realization and validation strategy

The CPU and GPU lanes share the FEM weak-form physics and descriptor signs,
but use separate PETSc runtime realizations. CPU source uses host vectors, a
persistent Schur MatShell and an exact materialized shifted preconditioner only
through dimension 1024. GPU source uses PETSc/SLEPc CUDA types and materializes
the shifted operator only through dimension 1024. Both materialized paths are
validation-only. The future production bindings require
`matrix_free_schur_selected_spectrum`, including a measured
`operator_dimension > 1024`; HYPRE and scalable matrix-free convergence remain
unvalidated until executed evidence exists. No transfer, allocation, residency
or readiness claim is promoted from source inspection.

Validation proceeds in this order:

1. Manufactured Robin and Dirichlet potential tests establish weak-form signs
   and gauge policy.
2. Sphere/ellipsoid tests establish demag field sign and energy positivity.
3. Primitive/supercell x/y PBC tests establish airbox periodic reduction.
4. Physical `BiasFieldSweep` samples establish K0-1, K0-2 and K0-3 Larmor,
   local-stiffness and thin-film Kittel behavior; analytical Kittel metadata
   participates only after each solve.
5. Multi-mode selected-spectrum tests establish the target transformation.
6. CPU `frequency_window` tests perturb both shift schedule and `nev`, preserve
   degenerate clusters by rank, compare invariant subspaces, and fail closed on
   disagreement, cancellation, or diagnostic truncation.
7. GPU `frequency_window` source tests exercise the same two-pass certificate,
   rank-two degeneracy, split-cluster disagreement, failed refinement,
   between-pass cancellation, and schedule truncation; runtime execution is a
   separate gate.
8. CPU/GPU parity applies only after both operate on the same real assembled
   blocks and both certify the original descriptor residual.

(validation)=
## 9. Validation evidence and completion gates

The current snapshot has source contracts and focused synthetic tests only for
the claims introduced here. Historical managed artifacts do not match HEAD plus
dirty ABI-v18 sources and therefore are not current execution evidence. Older
Kittel-driven fixtures also cannot qualify the physical field-sweep contract
when analytical samples supplied the field.

Promotion of either exact scope requires a fresh managed runtime tied to the
exact source snapshot and ABI v18, then:

1. three-to-five physical bias samples with accepted equilibrium provenance;
2. P1 mesh and airbox-padding convergence plus original-block residuals;
3. CPU/GPU block, action, frequency, residual and accepted/rejected parity;
4. GPU device identity, no-fallback, persistent-state, allocation and transfer
   evidence;
5. three-size scaling including at least one measured
   `operator_dimension > 1024` on `matrix_free_schur_selected_spectrum`,
   Compute Sanitizer and immutable release evidence;
6. artifact, OpenAPI/Control Room and browser-native provenance checks.

Until all applicable gates pass, `validated_scope` and `executable_scope` stay
null for the production CPU/GPU readiness cells.

### 9.1 K0-G0–K0-G9 qualification gates

These gates are cumulative. A source symbol, a declared zero counter or a
materialized oracle cannot replace measured managed-runtime evidence.

| Gate | Required evidence and threshold |
|---|---|
| K0-G0 identity/preflight | Host and managed container agree on GPU UUID/name/compute capability; PETSc CUDA initialization succeeds; source snapshot equals the runtime manifest; unavailable GPU fails closed. |
| K0-G1 negative contracts | Missing CUDA, CPU-backed Vec, wrong HYPRE policy, stale digest, illegal scope, NaN/zero count and fallback attempts reject before solve with stable reasons. |
| K0-G2 runtime substrate | A real modal mini-problem executes the complete `MatShell + STSINVERT + KSP + PCHYPRE + BV` object graph. |
| K0-G3 measured residency/scaling | `measurement_state=measured`; hot-loop computational H2D bytes, D2H bytes, full-vector crossings and host synchronizations are each zero; each scalar telemetry payload is at most 256 bytes and count is monitor-callback-bounded; native and external trace agree; three measured matrix-free dimensions are distinct and increasing, with at least one `operator_dimension > 1024`. |
| K0-G4 CPU oracle | CPU has a complete window, finite positive modes, original block residuals and independent postsolve Kittel certificate. |
| K0-G5 GPU physics | GPU passes manufactured/action parity, full residuals, physical Kittel sweep, mesh convergence and airbox-padding convergence without reference data in solver input. |
| K0-G6 CPU/GPU parity | Relative cluster-frequency delta $\le 10^{-8}$; sine of largest invariant-subspace angle $\le 10^{-8}$; aligned complex mode-field relative delta $\le 10^{-7}$; accepted/rejected mismatch count is zero; each lane has original $\epsilon_{\mathrm{full}}\le 10^{-8}$. |
| K0-G7 Kittel/antidot | Uniform overlap $\ge 0.95$; branch/subspace continuity $\ge 0.85$; residual, tangent leakage and seam mismatch $\le 10^{-8}$; Kittel maximum/median relative error $\le 2\times10^{-2}/10^{-2}$; finest-two mesh/airbox deltas $\le 10^{-2}/5\times10^{-3}$; fitted $M_{\mathrm{eff}}$ mesh/truncation/error deltas $\le 10^{-2}/5\times10^{-3}/5\times10^{-3}$; fitted relative standard uncertainty $\le 2.5\times10^{-3}$; scaled-Jacobian condition $\le 10^6$; Poisson original constraint residual $\le 10^{-8}$; the periodic antidot preserves mesh/equilibrium identity and emits nonempty spectrum and mode fields. |
| K0-G8 robustness/performance | Repetition, reuse/invalidation, cancellation, OOM admission and device loss preserve lifecycle without leaks; equal-physics CPU/GPU performance is reported without an invented minimum speedup; `memcheck`, `racecheck` and `synccheck` have separate sidecars. |
| K0-G9 UI/release | Typed API/resources, Results attestation, binary fields, native browser/WebGL/source-mesh proof and an immutable, hash-bound, two-identity release/promotion chain all pass. |

## 10. Completeness checklist

- [x] Public `BiasFieldSweep` Python/IR/planner/runner source contract
- [x] ABI-v18 native MFEM `A_qq` source owner for bounded P1 `tet4|prism6` exchange and parallel-field terms
- [x] Shared-domain BC/gauge, rotated-pencil and original-block residual source contracts
- [x] Source-level two-pass CPU window refinement certificate with cluster-rank
  and invariant-subspace comparison
- [x] Source-level two-pass GPU window refinement certificate with cluster-rank
  and invariant-subspace comparison
- [ ] Fresh authoritative managed-runtime execution of the CPU window certificate
- [ ] Fresh authoritative managed-runtime execution of the GPU window certificate
- [ ] Independent K0-3 physical sweep convergence and managed CPU/GPU parity
- [ ] Full persistent GPU EPS/ST/KSP/BV state and explicit invalidation proof
- [ ] GPU matrix-free convergence and scaling beyond the materialized bound
- [ ] Nonzero-k Floquet dynamic demag

(limitations)=
## 11. Known limits and deferred work

Nonzero-k dynamic demag, damping qualification, nonuniform-texture
qualification, arbitrary mesh-size coverage, GPU matrix-free convergence,
large-problem scaling, anisotropy/DMI in native `A_qq` and broad
periodic-airbox release gates remain open.
They must fail explicitly rather than reuse this bounded k=0 path.

The two-pass window certificate establishes stability of the requested modal
prefix under one deterministic shift-grid and `nev` perturbation. It is not a
contour-integral eigenvalue count and must not be interpreted as a mathematical
proof that every eigenvalue in an arbitrary interval was found.

(scientific-bibliography)=
## 12. Scientific bibliography

- W. F. Brown Jr., “Micromagnetics,” *Interscience Tracts on Physics and
  Astronomy*, no. 18, Wiley, 1963. Stable catalogue:
  [WorldCat 459671](https://search.worldcat.org/title/459671).
- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing
  fields,” *IEEE Transactions on Magnetics* 26(2), 415–417 (1990),
  [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
- C. Kittel, “On the Theory of Ferromagnetic Resonance Absorption,”
  *Physical Review* 73, 155–161 (1948),
  [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
- V. Hernandez, J. E. Roman and V. Vidal, “SLEPc: A Scalable and Flexible
  Toolkit for the Solution of Eigenvalue Problems,” *ACM Transactions on
  Mathematical Software* 31(3), 351–362 (2005),
  [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).

(source-code-index)=
## 13. Source-code index

All immutable links resolve the audited HEAD. Stable `path + symbol` remains
the primary identity when line numbers move.

| Equation/claim | Lane | Repository path + stable symbol | Responsibility | Tests | Evidence status | Immutable link |
|---|---|---|---|---|---|---|
| Physical sweep API | common | `packages/fullmag-py/src/fullmag/model/eigen.py` + `class BiasFieldSweep` | Validate SI samples and lower declared ordering/policies | `test_eigenmodes_bias_field_sweep_serializes_declared_si_samples` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/packages/fullmag-py/src/fullmag/model/eigen.py) |
| Stage-first modal authoring | common | `packages/fullmag-py/src/fullmag/world.py` + `eigenmodes_stage` | Lower the stage builder to public `Eigenmodes` | `test_study_stage_builder_bias_field_sweep_roundtrips_cpu_and_gpu_intent` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/packages/fullmag-py/src/fullmag/world.py) |
| User-authored relaxation stop | common | `packages/fullmag-py/src/fullmag/world.py` + `_resolve_flat_relax_stop` | Normalize authored `tolA`, `tolT` and energy tolerance into the canonical relaxation stop contract | focused Python relaxation serialization tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/packages/fullmag-py/src/fullmag/world.py) |
| Accepted relaxation handoff | common | `crates/fullmag-runner/src/fem_eigen.rs` + `from_completed_relax` | Validate and bind a completed user-authored relaxation criterion to the immutable stage handoff | runner handoff acceptance tests | design approved; implementation pending | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem_eigen.rs) |
| Equilibrium materialization | common | `crates/fullmag-runner/src/fem_eigen.rs` + `build_shared_domain_linearization_state` | Materialize the accepted equilibrium and retain relative torque as diagnostics | runner equilibrium materialization tests | design approved; implementation pending | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem_eigen.rs) |
| Sweep `ProblemIR` | common | `crates/fullmag-ir/src/study.rs` + `BiasFieldSweepIR` | Canonical physical request | `eigenmodes_bias_field_sweep_deserializes_and_rejects_invalid_physical_samples` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-ir/src/study.rs) |
| Sweep lifecycle and oracle isolation | common | `crates/fullmag-runner/src/fem_eigen.rs` + `execute_bias_field_sweep`, `validate_bias_field_sweep_oracle_contract` | Execute declared samples; keep Kittel postsolve-only | runner bias-sweep lifecycle and fail-closed oracle tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem_eigen.rs) |
| {eq}`eq-poisson-airbox-weak-form` and native `A_qq` | FEM CPU/common assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `assemble_native_magnetic_a_qq`, `assemble_poisson_airbox_shared_domain_payload`, `assemble_poisson_airbox_shared_domain` | MFEM P1 magnetic, scalar and mixed assembly | `poisson_airbox_shared_domain_test.cpp` | source tested; runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp) |
| Native magnetic `A_qq` declaration | FEM CPU/common assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` + `assemble_native_magnetic_a_qq` | Stable declaration for the implementation in `poisson_airbox_shared_domain.cpp` | `poisson_airbox_shared_domain_test.cpp` | source tested; runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp) |
| {eq}`eq-poisson-airbox-modal-block`, residuals and CPU window | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Stable declaration for the Schur solve, original residuals and two-pass certificate | focused CPU synthetic window tests | source tested; managed runtime missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp) |
| GPU selected-spectrum adapter | FEM GPU | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Declare the PETSc/SLEPc CUDA adapter implemented in `modal_petsc_slepc.cpp` | `run_n3_w1_focused_tests` | source tested; device runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp) |
| GPU persistent solver state | FEM GPU | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` + `create_gpu_solver_state` | Construct the source-visible GPU solver state whose reuse and residency still require runtime proof | focused GPU adapter tests | source tested; persistence unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp) |
| GPU matrix-free Schur action | FEM GPU | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` + `split_schur_matmult` (entrypoint `apply_schur`) | Apply the Schur operator used by the scalable selected-spectrum lane | focused GPU adapter tests | source tested; greater-than-1024 convergence unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp) |
| Native solver diagnostics projection | common | `crates/fullmag-runner/src/fem_eigen.rs` + `native_solver_diagnostics_json` | Project native convergence, solver-state and residency diagnostics into artifact JSON | runner tests | source tested; managed evidence missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem_eigen.rs) |
| Eigen-v2 bundle writer | common | `crates/fullmag-runner/src/fem_eigen.rs` + `write_eigen_v2_bundle` | Write spectrum, diagnostics and mode-field resources with source provenance | runner artifact tests | source tested; qualification bundle missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem_eigen.rs) |
| Eigen diagnostics API | common | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` + `frequency_domain_artifact_content_digest` (handler `get_frequency_domain_eigen_diagnostics_v2`) | Serve the typed session-scoped diagnostics resource | API tests | source visible; native browser proof missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs) |
| Mode-field metadata API | common | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` + `eigen_mode_field_metadata` (handler `get_frequency_domain_eigen_mode_field_meta`) | Serve typed metadata for the binary mode-field data plane | API tests | source visible; native browser proof missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs) |
| Results mode-field Inspector | UI | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` + `EigenModeFieldResourceInspectorPanel` | Inspect selected mode-field identity, availability and provenance | focused React tests | source visible; browser qualification missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx) |
| Unified viewport overlay intent | UI | `apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts` + `activate` on `class ModeFieldOverlayIntentController` | Bind the selected eigen mode and phase to the unified viewport overlay | focused controller tests | source visible; WebGL qualification missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts) |
| Artifact axis `bias_field_a_per_m` | common | `crates/fullmag-runner/src/eigen/artifacts.rs` + `field_sweep_axis` | Freeze writer axis, unit and display conversion | field-sweep artifact writer tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/eigen/artifacts.rs) |
| ABI v18 | common | `native/include/fullmag_fem.h` + `FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION`, `FullmagFemModalLinearizationDescriptor` | Version and backend-neutral physical handoff without preassembled `A_qq` | FFI ABI tests | source tested; active bundle mismatched | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/native/include/fullmag_fem.h) |
