
# Relaxation algorithms for FDM micromagnetics

- Status: implemented; FDM CPU and FDM CUDA lanes executable, not production-qualified
- Owners: Fullmag core
- Last updated: 2026-11-01
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`
  - `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`
  - `docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md`
  - `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
  - `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`

The cross-layer equilibrium, legality, observable, stop, and completion
contract is canonical in `0580`. This note owns the FDM realization of that
contract: the discrete equations, the CPU and CUDA algorithm loops, their fixed
internal parameters, the public FDM authoring path, and the FDM provenance. Any
conflicting statement here is superseded by `0580`.

(fdm-relax-problem-statement)=
## 1. Problem statement

Fullmag FDM relaxation computes a low-energy or metastable magnetization state
of a single-grid finite-difference model. Three algorithms are executable:

1. **Overdamped LLG** (`llg_overdamped`) — the standard explicit RK pipeline
   with the precession term removed, integrated in a stage-local clock.
2. **Projected gradient with Barzilai–Borwein steps** (`projected_gradient_bb`,
   PG-BB) — steepest descent on the sphere product manifold with alternating
   BB1/BB2 step sizes, a transported secant, and Armijo backtracking.
3. **Nonlinear conjugate gradient** (`nonlinear_cg`, NCG) — Polak–Ribière+
   conjugate directions with projection transport, periodic restarts, and
   Armijo backtracking.

PG-BB and NCG are *direct minimizers*: they own no RK integrator, no time step,
and no physical or pseudo time. Their accepted line-search step has the unit
$\mathrm{m\,A^{-1}}$. A relaxation result is a stationary point under the
unit-length constraint. It is not a proof of a global minimum; `0580` defines
how a local minimum, saddle, or numerical stagnation is distinguished.

The public multilayer FDM runner executes only `llg_overdamped`
([section 5.5](fdm-relax-discrete-realization)). `tangent_plane_implicit` is a
FEM-only algorithm and every FDM lane rejects it.

(fdm-relax-governing-equations)=
## 2. Governing equations

### 2.1 Constrained discrete minimization

The discrete conservative energy $E$ sums exchange, demagnetization, external
(Zeeman), uniaxial and cubic anisotropy, interfacial and bulk DMI, and
prescribed-strain magnetoelastic contributions over the $N$ active magnetic
cells. Relaxation seeks a local minimizer on the product of unit spheres:

```{math}
:label: eq-fdm-relax-minimization

\min_{\boldsymbol{m}\in(\mathbb{S}^2)^N} E[\boldsymbol{m}],
\qquad
|\boldsymbol{m}_i| = 1 \quad \forall i .
```

### 2.2 Tangent gradient and torque residual

With the tangent-plane projector
$P_{\boldsymbol{m}_i}=I-\boldsymbol{m}_i\boldsymbol{m}_i^{\mathsf T}$, the tangent
field gradient of cell $i$ is

```{math}
:label: eq-fdm-relax-tangent-gradient

\boldsymbol{g}_i
=-P_{\boldsymbol{m}_i}\boldsymbol{H}_{\mathrm{eff},i}
=-\Bigl[\boldsymbol{H}_{\mathrm{eff},i}
 -(\boldsymbol{m}_i\cdot\boldsymbol{H}_{\mathrm{eff},i})\,\boldsymbol{m}_i\Bigr].
```

Because $|\boldsymbol{m}_i|=1$, $|\boldsymbol{g}_i|=|\boldsymbol{m}_i\times\boldsymbol{H}_{\mathrm{eff},i}|$.
The canonical equilibrium residual, published as `max_torque_Apm`, is

```{math}
:label: eq-fdm-relax-max-torque

\tau_{\max}
=\max_{i}\left|\boldsymbol{m}_i\times\boldsymbol{H}_{\mathrm{eff},i}\right| .
```

It is always computed from the accepted magnetization and a fresh
accepted-state effective field, never from $|\mathrm{d}\boldsymbol{m}/\mathrm{d}t|$.

### 2.3 Physical energy metric

All inner products used by Armijo, BB, and CG are weighted by the magnetic
moment of the cell, so that a field-valued product multiplied by a step in
$\mathrm{m\,A^{-1}}$ is an energy in joules:

```{math}
:label: eq-fdm-relax-energy-metric

\langle\boldsymbol{a},\boldsymbol{b}\rangle_E
=\mu_0\sum_{i} M_{s,i}\,V\,\boldsymbol{a}_i\cdot\boldsymbol{b}_i .
```

Here $V$ is the uniform FDM cell volume. Cells with $M_{s,i}=0$ contribute
nothing. Frozen cells are restored to their reference direction in every trial
and therefore contribute a zero chord, but the CPU kernels do not mask their
gradient: it still enters the metric norms and the torque reduction
(section 11, item 10).

### 2.4 Retraction

A tangent increment is mapped back to the sphere by cellwise normalization,

```{math}
:label: eq-fdm-relax-retraction

\mathcal{R}_{\boldsymbol{m}_i}(\boldsymbol{v}_i)
=\frac{\boldsymbol{m}_i+\boldsymbol{v}_i}{|\boldsymbol{m}_i+\boldsymbol{v}_i|}.
```

This is a first-order retraction. A non-finite or vanishing norm makes the trial
invalid; the line search then halves the step instead of accepting it.

### 2.5 Overdamped LLG

`llg_overdamped` integrates the damping-only projection of the Gilbert LLG
equation:

```{math}
:label: eq-fdm-relax-overdamped-llg

\frac{\partial\boldsymbol{m}_i}{\partial t}
=-\frac{\gamma\,\alpha}{1+\alpha^2}\;
\boldsymbol{m}_i\times\left(\boldsymbol{m}_i\times\boldsymbol{H}_{\mathrm{eff},i}\right).
```

The time coordinate $t$ is a stage-local relaxation clock in seconds. It is an
execution coordinate, not a physical switching time, and it does not advance a
later `TimeEvolution` stage. The damping $\alpha$ is the relaxation damping:
the stage-first API overrides the material damping with `relax_alpha`
(default $1$) for this stage only.

### 2.6 Armijo sufficient decrease on the representable chord

For a trial state $\boldsymbol{m}^{\mathrm{trial}}$ produced by the retraction,
the representable floating-point chord and its first-order energy increment are

```{math}
:label: eq-fdm-relax-armijo-chord

\boldsymbol{s}_i^{\mathrm{fp}}
=\boldsymbol{m}_i^{\mathrm{trial,fp}}-\boldsymbol{m}_i^{\mathrm{fp}},
\qquad
\Delta E_{\mathrm{lin,chord}}
=-\mu_0\sum_i M_{s,i}\,V\,
\boldsymbol{H}_{\mathrm{eff},i}\cdot\boldsymbol{s}_i^{\mathrm{fp}} .
```

The trial is accepted only when $\Delta E_{\mathrm{lin,chord}}$ is finite and
strictly negative and

```{math}
:label: eq-fdm-relax-armijo-acceptance

E_{\mathrm{trial}}
\le E_{\mathrm{previous}}+c_1\,\Delta E_{\mathrm{lin,chord}}+\varepsilon_E,
\qquad c_1=10^{-4}.
```

$\varepsilon_E=0$ on the CPU reference and on CUDA double precision; with
$\varepsilon_E=0$ the trial must also strictly decrease the energy. CUDA single
precision uses the bounded roundoff budget
$\varepsilon_E=8\,\varepsilon_{\mathrm{f32}}|E_{\mathrm{previous}}|$ owned by
`0580`. The analytic slope $\langle\boldsymbol{g},\boldsymbol{p}\rangle_E$ is a
descent guard only; it is not the acceptance threshold because normalization
can move the stored trial off the analytic tangent line.

### 2.7 Projected gradient with Barzilai–Borwein steps

PG-BB updates

```{math}
:label: eq-fdm-relax-pgbb-update

\boldsymbol{m}_i^{(k+1)}
=\mathcal{R}_{\boldsymbol{m}_i^{(k)}}\!\left(-\lambda\,\boldsymbol{g}_i^{(k)}\right),
```

halving $\lambda$ after each failed Armijo trial (at most 20 backtracks). After
an accepted step, the BB secant is formed in the tangent space of the new
iterate:

```{math}
:label: eq-fdm-relax-bb-secant

\tilde{\boldsymbol{s}}_k
=P_{\boldsymbol{m}_i^{(k+1)}}\!\left(\boldsymbol{m}_i^{(k+1)}-\boldsymbol{m}_i^{(k)}\right),
\qquad
\tilde{\boldsymbol{y}}_k
=\boldsymbol{g}_i^{(k+1)}-P_{\boldsymbol{m}_i^{(k+1)}}\boldsymbol{g}_i^{(k)} .
```

The two BB step candidates, clamped to $[\lambda_{\min},\lambda_{\max}]$, are

```{math}
:label: eq-fdm-relax-bb-steps

\lambda_{\mathrm{BB1}}
=\frac{\langle\tilde{\boldsymbol{s}}_k,\tilde{\boldsymbol{s}}_k\rangle_E}
      {\langle\tilde{\boldsymbol{s}}_k,\tilde{\boldsymbol{y}}_k\rangle_E},
\qquad
\lambda_{\mathrm{BB2}}
=\frac{\langle\tilde{\boldsymbol{s}}_k,\tilde{\boldsymbol{y}}_k\rangle_E}
      {\langle\tilde{\boldsymbol{y}}_k,\tilde{\boldsymbol{y}}_k\rangle_E},
\qquad
\lambda\leftarrow\min\!\left(\max(\lambda_{\mathrm{BB}},\lambda_{\min}),\lambda_{\max}\right).
```

The preferred formula alternates every accepted step, starting with BB1. BB1
requires a finite $\langle\tilde{\boldsymbol{s}},\tilde{\boldsymbol{y}}\rangle_E>0$.
BB2 additionally requires a finite
$\langle\tilde{\boldsymbol{y}},\tilde{\boldsymbol{y}}\rangle_E>0$; when only that
second guard fails, BB1 is used instead. A BB1 turn has no BB2 fallback. When
the active formula is rejected, the consecutive failure counter
$k_{\mathrm{reset}}$ is incremented and the step is reset to

```{math}
:label: eq-fdm-relax-bb-reset

\lambda
=\min\!\left(\max\!\left(\frac{\lambda_0}{k_{\mathrm{reset}}+1},\lambda_{\min}\right),\lambda_{\max}\right),
```

with $k_{\mathrm{reset}}\ge1$. The counter returns to zero after the next
accepted BB quotient.

### 2.8 Nonlinear conjugate gradient (Polak–Ribière+)

NCG uses the same gradient, metric, retraction, and Armijo rule. The previous
gradient and direction are moved to the tangent space of the new iterate by
projection transport,

```{math}
:label: eq-fdm-relax-ncg-transport

\mathcal{T}_{k\to k+1}\,\boldsymbol{v}_i
=P_{\boldsymbol{m}_i^{(k+1)}}\boldsymbol{v}_i
=\boldsymbol{v}_i-\left(\boldsymbol{m}_i^{(k+1)}\cdot\boldsymbol{v}_i\right)\boldsymbol{m}_i^{(k+1)} .
```

The PR+ coefficient is computed in the energy metric and forced to zero every
$n_{\mathrm{restart}}=50$ accepted steps:

```{math}
:label: eq-fdm-relax-ncg-beta

\beta_{k+1}
=\begin{cases}
0, & (k+1)\bmod n_{\mathrm{restart}}=0,\\[4pt]
\max\!\left(0,\;
\dfrac{\left\langle\boldsymbol{g}^{(k+1)},\,
\boldsymbol{g}^{(k+1)}-\mathcal{T}_{k\to k+1}\boldsymbol{g}^{(k)}\right\rangle_E}
{\left\langle\boldsymbol{g}^{(k)},\boldsymbol{g}^{(k)}\right\rangle_E}\right), & \text{otherwise.}
\end{cases}
```

The next direction is

```{math}
:label: eq-fdm-relax-ncg-direction

\boldsymbol{p}_i^{(k+1)}
=-\boldsymbol{g}_i^{(k+1)}+\beta_{k+1}\,\mathcal{T}_{k\to k+1}\boldsymbol{p}_i^{(k)},
```

reset to $-\boldsymbol{g}^{(k+1)}$ whenever
$\langle\boldsymbol{p}^{(k+1)},\boldsymbol{g}^{(k+1)}\rangle_E\ge0$. The same
descent reset is applied before each line search. Each line search starts from

```{math}
:label: eq-fdm-relax-ncg-initial-step

\lambda=\min\!\left(\lambda_0,\;\frac{1}{\lVert\boldsymbol{p}\rVert_2}\right),
\qquad
\lVert\boldsymbol{p}\rVert_2=\Bigl(\sum_i\boldsymbol{p}_i\cdot\boldsymbol{p}_i\Bigr)^{1/2},
```

with $\lambda=\lambda_0$ for a zero direction, then halves at most 30 times. The
unweighted Euclidean norm here only bounds the first trial; acceptance still
uses equation {eq}`eq-fdm-relax-armijo-acceptance`.

### 2.9 Stop predicate

The public torque tolerance is authored either in tesla or in amperes per metre
and lowered to the canonical field unit:

```{math}
:label: eq-fdm-relax-tolerance-lowering

H_{\mathrm{tol}}=\frac{B_{\mathrm{tol}}}{\mu_0},
\qquad
B_{\mathrm{tol}}=10^{-6}\ \mathrm{T}\ \text{by default}
\;\Rightarrow\;
H_{\mathrm{tol}}=0.7957747154594766\ \mathrm{A\,m^{-1}} .
```

For every accepted state, the relaxation converges when an enabled criterion
holds (`0580`, equation `eq-relaxation-any-enabled-stop`):

```{math}
:label: eq-fdm-relax-stop

\tau_{\max}\le H_{\mathrm{tol}}\ \text{on three consecutive accepted states}
\quad\lor\quad
\max_{50}E-\min_{50}E\le\varepsilon_{\mathrm{plateau}},
\qquad k\le n_{\max}.
```

The energy window holds the last 50 accepted energies. Reaching $n_{\max}$ is a
budget stop with `converged=false`, not convergence.

(fdm-relax-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $E$ | total discrete conservative micromagnetic energy | $\mathrm{J}$ |
| $\boldsymbol{m}_i$ | unit magnetization direction of active cell i | $1$ |
| $N$ | number of active magnetic cells | $1$ |
| $\boldsymbol{H}_{\mathrm{eff},i}$ | conservative effective field of cell i | $\mathrm{A\,m^{-1}}$ |
| $P_{\boldsymbol{m}_i}$ | tangent-plane projector at cell i | $1$ |
| $\boldsymbol{g}_i$ | tangent field gradient of cell i | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max}$ | maximum torque residual over active cells (max_torque_Apm) | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | saturation magnetization of cell i | $\mathrm{A\,m^{-1}}$ |
| $V$ | uniform FDM cell volume | $\mathrm{m^{3}}$ |
| $\langle\boldsymbol{a},\boldsymbol{b}\rangle_E$ | physical energy-metric product of two field-valued cell vectors | $\mathrm{J\,A\,m^{-1}}$ |
| $\mathcal{R}_{\boldsymbol{m}_i}$ | cellwise normalization retraction | $1$ |
| $\boldsymbol{v}_i$ | dimensionless increment passed to the retraction | $1$ |
| $\gamma$ | gyromagnetic ratio used with H | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | relaxation damping of the overdamped LLG stage | $1$ |
| $t$ | stage-local relaxation clock of llg_overdamped | $\mathrm{s}$ |
| $\boldsymbol{s}_i^{\mathrm{fp}}$ | representable floating-point trial chord of cell i | $1$ |
| $\Delta E_{\mathrm{lin,chord}}$ | first-order energy increment along the stored trial chord | $\mathrm{J}$ |
| $E_{\mathrm{trial}}$ | energy of the candidate trial state | $\mathrm{J}$ |
| $E_{\mathrm{previous}}$ | energy of the last accepted state | $\mathrm{J}$ |
| $c_1$ | Armijo sufficient-decrease coefficient | $1$ |
| $\varepsilon_E$ | precision-dependent Armijo energy budget | $\mathrm{J}$ |
| $\varepsilon_{\mathrm{f32}}$ | float32 machine epsilon | $1$ |
| $\lambda$ | direct-minimizer line-search step | $\mathrm{m\,A^{-1}}$ |
| $\lambda_0$ | default initial and reset base step | $\mathrm{m\,A^{-1}}$ |
| $\lambda_{\min}$ | lower clamp of the BB step | $\mathrm{m\,A^{-1}}$ |
| $\lambda_{\max}$ | upper clamp of the BB step | $\mathrm{m\,A^{-1}}$ |
| $\tilde{\boldsymbol{s}}_k$ | tangent-projected BB magnetization secant | $1$ |
| $\tilde{\boldsymbol{y}}_k$ | transported BB gradient difference | $\mathrm{A\,m^{-1}}$ |
| $k_{\mathrm{reset}}$ | consecutive rejected BB quotients | $1$ |
| $k$ | accepted direct-minimizer iteration index | $1$ |
| $\mathcal{T}_{k\to k+1}$ | projection vector transport to the new tangent space | $1$ |
| $\beta_{k+1}$ | Polak-Ribiere+ conjugate-gradient coefficient | $1$ |
| $\boldsymbol{p}_i$ | NCG search direction of cell i | $\mathrm{A\,m^{-1}}$ |
| $n_{\mathrm{restart}}$ | NCG restart interval in accepted steps | $1$ |
| $H_{\mathrm{tol}}$ | canonical torque stop threshold in field units | $\mathrm{A\,m^{-1}}$ |
| $B_{\mathrm{tol}}$ | public torque stop threshold in induction units (tolT) | $\mathrm{T}$ |
| $\varepsilon_{\mathrm{plateau}}$ | energy-plateau stop tolerance | $\mathrm{J}$ |
| $n_{\max}$ | accepted-step budget (max_steps) | $1$ |

`max_torque_T` $=\mu_0\tau_{\max}$ is an auxiliary observable in $\mathrm{T}$.
`max_rhs_norm_per_s` $=\max_i|\mathrm{d}\boldsymbol{m}_i/\mathrm{d}t|$ in
$\mathrm{s^{-1}}$ is a separate dynamic observable and never a convergence
substitute. Vector artifacts named `torque` keep the Tesla-style field-space
payload of the preview path; component names such as `torque.x` inherit the
base unit.

(fdm-relax-assumptions-and-validity)=
## 4. Assumptions and validity

1. **Conservative problem.** Relaxation minimizes a conservative energy.
   Spin-transfer and spin-orbit torques, stochastic thermal fields,
   time-dependent fields, and terms present in $\boldsymbol{H}_{\mathrm{eff}}$
   without a matching energy are rejected (`0580`, section 2.4). Oersted is a
   field observable without a published conservative energy term and is
   rejected by direct-minimizer relaxation.
2. **Zero temperature, deterministic.** No thermal noise enters any lane.
3. **Uniform cell volume.** The FDM metric uses one cell volume $V$; spatial
   variation enters only through $M_{s,i}$ and the active mask.
4. **First-order retraction and transport.** Normalization and projection
   transport are first-order on the sphere. Armijo backtracking keeps accepted
   steps in the regime where this is a descent method; exact geodesic or Cayley
   updates are not implemented.
5. **Fresh fields at decisions.** Every Armijo trial evaluates a fresh total
   energy, and every accepted state evaluates a fresh effective field before
   the torque decision. No cached demag field enters a stop decision.
6. **Precision floor.** The torque tolerance must lie above the floating-point
   floor of the problem. Below it, Armijo exhausts its backtracks and the run
   ends as `numerical_stagnation` with `converged=false`, not as convergence.
7. **Stationarity, not optimality.** A converged state satisfies equation
   {eq}`eq-fdm-relax-stop`; it may be a saddle or a local minimum.

(fdm-relax-discrete-realization)=
## 5. Discrete realization

### 5.1 Backend support matrix

| Lane | Status | `llg_overdamped` | `projected_gradient_bb` / `nonlinear_cg` | Realization recorded in provenance |
|---|---|---|---|---|
| FDM CPU | documented; executable, unvalidated | executable, precession disabled | executable on single-grid FDM; SoA or AoS kernel by problem shape | `cpu_soa_tangent_gradient` or `cpu_aos_tangent_gradient` for BB/NCG; `native_llg_time_integrator` for LLG |
| FDM GPU | documented; CUDA development executable, unvalidated | executable through the CUDA RK pipeline | executable on single-grid FDM through a host-orchestrated loop over CUDA field and energy evaluation; Frozen Spins rejected | see section 8.3 |
| FEM CPU | not applicable | owned by `0510`/`0580` | owned by `0510`/`0580` (native MFEM realizations) | `native_mfem_pgbb`, `native_mfem_nonlinear_cg`, `native_mfem_tpi` |
| FEM GPU | not applicable | owned by `0510`/`0580` | owned by `0510`/`0580` (native CUDA realizations) | `native_cuda_pgbb`, `native_cuda_nonlinear_cg` |

The FEM rows are not FDM lanes. The FEM equations, mass-weighted metric, and
native realizations are documented in `0510` and `0580`; this page makes no FEM
claim. No lane holds a source-bound managed qualification receipt, so the
capability matrix keeps every relaxation row at `unvalidated`.

### 5.2 Discretization

Cells are the FDM grid cells of the resolved single-grid plan. The active set is
the set of cells with $M_{s,i}>0$ inside the active mask; inactive cells carry
zero magnetization, zero gradient, and zero metric weight. The effective field
and energy are those of the selected interactions (`0400`, `0420`); the
direct-minimizer energy includes exchange, demag, external field,
uniaxial/cubic anisotropy, interfacial/bulk DMI, and prescribed-strain
magnetoelastic energy when active.

### 5.3 FDM CPU realization

The CPU reference (`execution_engine="cpu_reference"`, FP64) dispatches each
algorithm from one runner entry point.

- **LLG.** `llg_overdamped` runs the selected RK tableau with the problem's
  precession term disabled; the RHS is equation
  {eq}`eq-fdm-relax-overdamped-llg`.
- **SoA kernels.** When the problem admits the persistent structure-of-arrays
  layout, PG-BB and NCG run on `VectorFieldSoA` buffers with zero-allocation
  field, gradient, and energy evaluation.
- **AoS kernels.** When the problem rejects the SoA layout, the same algorithms
  run on array-of-structures vectors. The SoA rejection reasons are, in
  priority order, `frozen_spins` (at least one frozen degree of freedom),
  `spatial_saturation_magnetisation`, `spatial_exchange_stiffness`, and
  `spatial_damping`. The SoA and AoS kernels implement the same equations; the
  regression tests in section 10 compare them on one fixture.
- **Frozen Spins.** A frozen cell is reset to its reference direction inside
  the retraction of every trial, so its chord vanishes. Its tangent gradient is
  not masked and still enters the metric norms, the BB/CG products, and
  $\tau_{\max}$.

### 5.4 FDM CUDA realization

The CUDA lane (`execution_engine="cuda_fdm"`) runs LLG on the native CUDA RK
pipeline. For PG-BB and NCG it keeps the optimizer state on the host and uses
the device for field and energy evaluation: each trial uploads the trial
magnetization and reads the device energy statistics; each accepted step copies
the device effective field back to compute the tangent gradient. The step-size
update, PR+ coefficient, transport, and Armijo test are the shared helpers used
by equations {eq}`eq-fdm-relax-bb-secant` to {eq}`eq-fdm-relax-ncg-initial-step`.
Single precision applies the bounded $\varepsilon_E$ of `0580`; double precision
uses $\varepsilon_E=0$. Frozen Spins with a direct minimizer are rejected before
the loop starts (`frozen_spins_cuda_direct_minimizer_unqualified`), because the
native trial retraction does not consume the frozen reference. Heterogeneous
cellwise material fields are rejected on CUDA as in the capability matrix.

### 5.5 Multilayer FDM

`FdmMultilayerPlanIR` carries the same relaxation control, but the multilayer
planner accepts only `llg_overdamped`. PG-BB and NCG are rejected until the
trial evaluator can recompute the global demag energy and effective field for
every Armijo backtrack on CPU, CUDA double, CUDA single, and compatible
native-stacked CUDA paths. The design is in
`docs/superpowers/specs/2026-07-12-fdm-multilayer-direct-minimizer-design.md`.

### 5.6 Fixed internal parameters

These parameters are compiled constants, identical on CPU and CUDA, and are not
exposed in `ProblemIR`.

| Parameter | PG-BB | NCG | Reason |
|---|---|---|---|
| $\lambda_0$ | $10^{-6}\ \mathrm{m\,A^{-1}}$ | $\min(10^{-6}\ \mathrm{m\,A^{-1}},1/\lVert\boldsymbol{p}\rVert_2)$ per line search | conservative first trial |
| $\lambda_{\min}$, $\lambda_{\max}$ | $10^{-15}$, $10^{-3}\ \mathrm{m\,A^{-1}}$ | not used | BB clamp |
| $c_1$ | $10^{-4}$ | $10^{-4}$ | standard Armijo value |
| backtrack factor / limit | $1/2$, 20 | $1/2$, 30 | NCG directions need more trials |
| restart interval $n_{\mathrm{restart}}$ | not used | 50 accepted steps | limits accumulated direction drift |
| degenerate gradient | $\langle\boldsymbol{g},\boldsymbol{g}\rangle_E=0$ | same | numerical stagnation unless an exact-equilibrium confirmation passes |
| torque confirmation | 3 consecutive accepted states | same | shared stop contract |
| energy plateau window | 50 accepted states | same | shared stop contract |

### 5.7 Stagnation and degenerate gradients

An exactly zero metric gradient norm is not treated as convergence by itself.
When the torque criterion is enabled, already satisfied, and no energy criterion
is configured, the runner refreshes the field and runs the torque confirmation;
otherwise, or if confirmation fails, the stop is `numerical_stagnation` with
`converged=false`. A non-finite or negative gradient norm, or an invalid active
magnetization, is a numerical error. Exhausting the Armijo backtracks is
`numerical_stagnation`.

### 5.8 Observable and artifact refresh on CPU

Direct minimizers publish `accepted_step_m_per_A`, `line_search_backtracks`,
energy and field evaluation counts, and the canonical torque. On the CPU
reference, scalar-only scheduled rows reuse the last `StepReport`; `m`, `H_ext`,
`H_ani`, `H_ex`, `H_demag`, `H_dmi`, and `H_eff` snapshots use direct field
accessors; `torque` derives from the observable effective field, and one output
pass shares one `H_eff` assembly between sibling component snapshots and
`torque`. Final output passes reuse a current-time scalar row instead of
reassembling full observables. These are output-cost rules; they do not change
the relaxation equations.

### 5.9 Comparison with other codes

| Aspect | Fullmag FDM | Boris (Lepadatu 2020) | OOMMF `Oxs_CGEvolve` |
|---|---|---|---|
| Gradient | $-P_{\boldsymbol{m}}\boldsymbol{H}_{\mathrm{eff}}$ in A/m | torque-based | energy gradient |
| Update | normalization retraction | Cayley transform | Rodrigues rotation |
| BB secant | tangent-projected, energy metric | ambient difference | not used |
| Line search | Armijo on representable chord | none | bracket and cubic interpolation |
| CG coefficient | PR+ in energy metric, restart every 50 | not used | Fletcher-Reeves default |

The table compares documented method choices only; it is not a performance or
accuracy claim.

(fdm-relax-python-api)=
## 6. Python API

The public path is the stage-first study API. The example below relaxes the
NIST µMAG standard problem 4 film geometry on the FDM CPU lane with NCG.

```python
# %%
import fullmag as fm

# %%
study = fm.study("fdm_sp4_relax_nonlinear_cg")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %%
study.universe(
    mode="manual",
    size=(500e-9, 125e-9, 3e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 3e-9)

film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

# %%
study.demag()

# %%
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    tolA=1.0,
    max_steps=20_000,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "mx", "my", "mz", "e_ex", "e_demag", "e_total", "max_torque_T"],
        ),
        fields=[],
    )
)
study.stages.add_save_state(
    artifact_name="relaxed_m.zarr",
    format="zarr",
    dataset="m",
)
```

Replace `algorithm="nonlinear_cg"` with `"projected_gradient_bb"` for PG-BB, or
use `study.device("gpu", precision="double")` for the CUDA lane. For
`llg_overdamped`, an explicit time-step policy is required, for example
`study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1.0)`.

Evidence status: the example lowers through `load_problem_from_script` at the
reviewed revision and produces the `ProblemIR` excerpt in section 7. Its solver
execution is not recorded in this note and remains not verified for this page.

### 6.1 Parameters of `study.stages.add_relax`

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `study.stages.add_relax(stage_id=...)` | `str or None` | `None` (allocated `relax-1`, `relax-2`, ...) | $1$ | unique stage identifier | stage identity in the study pipeline | FDM CPU/GPU | `study_pipeline.nodes[].id` |
| `study.stages.add_relax(algorithm=...)` | `str` | `"llg_overdamped"` | $1$ | one of llg_overdamped, projected_gradient_bb, nonlinear_cg, tangent_plane_implicit; FDM planner rejects tangent_plane_implicit | relaxation algorithm | FDM CPU/GPU single-grid; multilayer llg_overdamped only | `study.algorithm` |
| `study.stages.add_relax(tolT=...)` | `float` | `1e-6` when neither tolT nor tolA is given | $\mathrm{T}$ | finite and positive; at most one of tolT and tolA | torque threshold in induction units, lowered by equation eq-fdm-relax-tolerance-lowering | FDM CPU/GPU | `study.stop.torque_tolerance_apm` |
| `study.stages.add_relax(tolA=...)` | `float` | not set | $\mathrm{A\,m^{-1}}$ | finite and positive; at most one of tolT and tolA | torque threshold in field units | FDM CPU/GPU | `study.stop.torque_tolerance_apm` |
| `study.stages.add_relax(tol=...)` | removed | not accepted | $1$ | always raises ValueError: tol has been removed; use tolT or tolA | migration guard | FDM CPU/GPU | not lowered |
| `study.stages.add_relax(energy_tolerance=...)` | `float` | not set | $\mathrm{J}$ | finite and positive | 50-accepted-state energy-plateau threshold | FDM CPU/GPU | `study.stop.energy_tolerance_j` |
| `study.stages.add_relax(max_steps=...)` | `int or None` | `50000` | $1$ | positive integer; None removes the step budget | accepted-step budget | FDM CPU/GPU | `study.stop.max_steps` |
| `study.stages.add_relax(max_relaxation_time_s=...)` | `float or None` | not set | $\mathrm{s}$ | positive; llg_overdamped only, otherwise ValueError | stage-local relaxation clock budget | FDM CPU/GPU, llg_overdamped | `study.stop.max_relaxation_time_s` |
| `study.stages.add_relax(max_pseudotime_s=..., max_physical_time_s=...)` | `float` | not set | $\mathrm{s}$ | deprecated aliases of max_relaxation_time_s; conflicting values raise ValueError | migration aliases | FDM CPU/GPU, llg_overdamped | `study.stop.max_relaxation_time_s` |
| `study.stages.add_relax(stop=...)` | `fm.RelaxStop or None` | `None` | $1$ | conflicts with tolT, tolA, energy_tolerance, or max_steps raise ValueError | complete stop contract; RelaxStop(torque_tolerance_apm=None) disables the torque criterion | FDM CPU/GPU | `study.stop` |
| `study.stages.add_relax(relax_alpha=...)` | `float or None` | `1.0` for llg_overdamped | $1$ | llg_overdamped only, otherwise TypeError; None keeps the material damping | relaxation damping override | FDM CPU/GPU, llg_overdamped | `materials[].damping` of the stage problem |
| `study.stages.add_relax(solver=...)` | `str or None` | `None` (auto, resolved to rk23) | $1$ | one of abm3, auto, coupled_imex_ark2, heun, rk23, rk4, rk45; llg_overdamped only, otherwise TypeError | LLG integrator | FDM CPU/GPU, llg_overdamped | `study.dynamics.integrator` |
| `study.stages.add_relax(dt=...)` | `float or None` | `None` | $\mathrm{s}$ | positive; llg_overdamped only; an explicit fixed or complete adaptive policy is required | fixed LLG time step | FDM CPU/GPU, llg_overdamped | `study.dynamics.fixed_timestep` |
| `study.stages.add_relax(max_err=..., dt_initial=..., dt_min=..., dt_max=...)` | `float or None` | `None` | $1$ for max_err; $\mathrm{s}$ for steps | llg_overdamped only; adaptive integrator rk23 or rk45; dt_min and dt_max required | adaptive LLG policy | FDM CPU/GPU, llg_overdamped | `study.dynamics.adaptive_timestep` |
| `study.stages.add_relax(adaptive_timestep=...)` | `fm.AdaptiveTimestep or None` | `None` | $\mathrm{s}$ | llg_overdamped only; not mixable with dt, max_error, max_err, dt_initial, dt_min, dt_max | complete adaptive LLG policy object | FDM CPU/GPU, llg_overdamped | `study.dynamics.adaptive_timestep` |
| `study.stages.add_relax(max_error=...)` | `float or None` | `None` | $1$ | deprecated; llg_overdamped only; not mixable with max_err or dt_initial | legacy adaptive error target | FDM CPU/GPU, llg_overdamped | `study.dynamics.adaptive_timestep.atol` |
| `study.stages.add_relax(field_refresh=...)` | `fm.FieldRefreshPolicy or None` | `None` | $\mathrm{s}$ | llg_overdamped only, otherwise TypeError | demag refresh cadence during LLG relaxation (0530) | FDM CPU/GPU, llg_overdamped | `study.dynamics.field_refresh` |
| `study.stages.add_relax(constraints=...)` | `Sequence[fm.FrozenSpins]` | `()` | $1$ | valid FrozenSpins selections; FDM CUDA rejects Frozen Spins with BB/NCG | frozen magnetization constraints active in the stage | FDM CPU all algorithms; FDM GPU llg_overdamped | `magnetization_constraints[]` |
| `study.stages.add_relax(...).autosave(...)` | `fm.StageAutosave` | no autosave | $1$ | valid table quantities and field names | stage-local table and field autosave | FDM CPU/GPU | `study_pipeline.nodes[].payload.autosave` |

`tolT` and `tolA` accept only a finite positive number; passing `None` raises
`TypeError`. To disable the torque criterion, pass
`stop=fm.RelaxStop(torque_tolerance_apm=None, energy_tolerance_j=...)`.
`fm.RelaxStop` validates that at least one stop criterion remains. The
low-level `fm.Relaxation(...)` object accepts the same algorithm names and stop
contract; its use outside the stage-first API is a compatibility surface.

(fdm-relax-problem-ir)=
## 7. ProblemIR

The stage problem lowered from the example (`load_problem_from_script`, stage
`relax`) serializes to the following `ProblemIR` excerpt. Keys are shown
exactly as produced; unrelated top-level collections are omitted.

```json
{
  "ir_version": "0.3.0",
  "study": {
    "kind": "relaxation",
    "algorithm": "nonlinear_cg",
    "stop": {"torque_tolerance_apm": 1.0, "max_steps": 20000},
    "sampling": {"outputs": []}
  },
  "backend_policy": {
    "requested_backend": "fdm",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": {"cell": [5e-09, 5e-09, 3e-09], "default_cell": [5e-09, 5e-09, 3e-09]}
    }
  },
  "validation_profile": {"execution_mode": "strict"},
  "energy_terms": [{"kind": "exchange"}, {"kind": "demag", "realization": "auto"}],
  "magnetization_constraints": [],
  "problem_meta": {
    "runtime_metadata": {
      "runtime_selection": {
        "backend": "fdm",
        "device": "cpu",
        "execution_mode": "strict",
        "execution_precision": "double"
      }
    }
  },
  "materials": [
    {
      "name": "mat_film",
      "saturation_magnetisation": 800000.0,
      "exchange_stiffness": 1.3e-11,
      "damping": 0.02
    }
  ]
}
```

The direct minimizer carries no `dynamics` key. The same stage with
`algorithm="llg_overdamped", dt=1e-13` lowers to
`"dynamics": {"kind": "llg", "gyromagnetic_ratio": 221100.0, "integrator": "rk23", "fixed_timestep": 1e-13}`
and to `materials[0].damping = 1.0` through the default `relax_alpha`. The stage
autosave is stored in the study pipeline document
(`study_pipeline.nodes[0].payload.autosave`), not in `study.sampling`.

Rust types: `StudyIR::Relaxation { algorithm, dynamics, stop, sampling }`,
`RelaxationAlgorithmIR` (`llg_overdamped`, `projected_gradient_bb`,
`nonlinear_cg`, `tangent_plane_implicit`), and `RelaxStopIR`
(`torque_tolerance_apm`, `energy_tolerance_j`, `max_steps`,
`max_relaxation_time_s`). The planner copies `algorithm` and `stop` into
`RelaxationControlIR` of the FDM plan.

| Python | ProblemIR | Normalization |
|---|---|---|
| `algorithm` | `study.algorithm` | snake_case enum string |
| `tolT` / `tolA` | `study.stop.torque_tolerance_apm` | tolT divided by $\mu_0$; default $0.7957747154594766$ |
| `energy_tolerance` | `study.stop.energy_tolerance_j` | omitted when not set |
| `max_steps` | `study.stop.max_steps` | default 50000; omitted when None |
| `max_relaxation_time_s` and aliases | `study.stop.max_relaxation_time_s` | legacy aliases merged; never re-emitted |
| `solver`, `dt`, adaptive controls, `field_refresh` | `study.dynamics` | present only for llg_overdamped |
| `relax_alpha` | `materials[].damping` | applied to the stage problem only |
| `constraints` | `magnetization_constraints[]` | stage-scoped Frozen Spins |
| `study.device(...)`, `study.mode(...)` | `problem_meta.runtime_metadata.runtime_selection`, `validation_profile.execution_mode` | requested intent, not the resolved lane |

(fdm-relax-round-trip-and-failure-semantics)=
## 8. Round trip, provenance, and failure semantics

### 8.1 Requested intent and resolved execution

The requested intent is `runtime_selection` (backend, device, precision, mode)
together with `study.algorithm`. The resolved execution is recorded in the run
provenance as `execution_engine` (`cpu_reference` or `cuda_fdm`), `precision`,
and the energy-minimizer fields below. A forced GPU request never falls back to
the CPU lane, and an `auto` device stays visible as requested intent.

### 8.2 Round trip

Canonical export writes `study.algorithm`, the canonical `RelaxStopIR` fields,
and `dynamics` only for `llg_overdamped`. Deprecated names (`torque_tolerance`,
`max_pseudotime_s`, `max_physical_time_s`) are accepted on input, normalized,
and never re-emitted. For the section 6 example, rendering the loaded problem
with `render_loaded_problem_as_script` and loading the rendered script again
reproduces an identical `study` object and the same stage order.

### 8.3 Energy-minimizer provenance

CPU FDM run provenance records direct minimization explicitly. For PG-BB and NCG
it sets `requested_energy_minimizer` and `resolved_energy_minimizer` to the
algorithm name and `energy_minimizer_realization` to the kernel family that
executed:

- `"cpu_soa_tangent_gradient"` when the problem admits the SoA fast path;
- `"cpu_aos_tangent_gradient"` when it rejects it (Frozen Spins, spatial
  $M_s$, $A_{\mathrm{ex}}$, or $\alpha$).

The runner and the kernel dispatch use the same predicate. Final-artifact
validation derives the expected value from
`fdm_cpu_state_layout.rejection_reason`: a problem-level rejection expects the
AoS realization, while `coupled_spin_transport` forces only the AoS state layout
and still expects the SoA minimizer realization. A mismatch fails finalization.
LLG relaxation leaves the requested/resolved minimizer fields unset, reports the
resolved integrator, and records
`energy_minimizer_realization = "native_llg_time_integrator"`.

For the CUDA lane, final-artifact validation expects `native_cuda_pgbb` or
`native_cuda_nonlinear_cg`. Source inspection at the reviewed revision shows
that the CUDA FDM provenance builder does not populate the requested, resolved,
or realization fields for BB/NCG; this lane's final provenance is therefore not
verified (section 11).

### 8.4 Validation errors and unsupported combinations

| Combination | Layer | Result |
|---|---|---|
| unknown algorithm string | Python | `ValueError` listing the four algorithm names |
| `tangent_plane_implicit` with `engine("fdm")` | planner | rejected: FEM-only algorithm |
| `projected_gradient_bb` or `nonlinear_cg` on multilayer FDM | planner | rejected: multilayer runner supports only llg_overdamped |
| direct minimizer with `solver`, `dt`, adaptive controls, `field_refresh`, or `relax_alpha` | Python | `TypeError`: supported only for llg_overdamped |
| direct minimizer with `max_relaxation_time_s` | Python and ProblemIR | `ValueError`; IR validation rejects it as well |
| direct minimizer with `dynamics` in IR | ProblemIR | rejected: direct minimizer requires dynamics=None |
| `llg_overdamped` without explicit fixed or complete adaptive time step | Python | `ValueError` |
| both `tolT` and `tolA`, or removed `tol` | Python | `ValueError` |
| non-finite or non-positive tolerance, `max_steps <= 0` | Python and ProblemIR | `ValueError` / IR validation error |
| no remaining stop criterion | Python and ProblemIR | rejected |
| Frozen Spins with BB/NCG on FDM CUDA | runner, before execution | `frozen_spins_cuda_direct_minimizer_unqualified` |
| heterogeneous cellwise material fields on FDM CUDA | planner/runner | rejected (capability matrix) |
| Oersted, spin torques, thermal field, time-dependent drive in a relaxation | planner | rejected (`0580`, section 2.4) |

Runtime failures are typed: Armijo exhaustion and degenerate gradients are
`numerical_stagnation`; non-finite gradient, energy, or magnetization is a
backend error; `max_steps` is a budget stop. None of them sets
`converged=true`.

(fdm-relax-implementation-mapping)=
## 9. Implementation mapping

| Equation or claim | Source path | Symbol |
|---|---|---|
| eq-fdm-relax-minimization, energy terms | `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs` | `total_energy_from_soa_ws` |
| eq-fdm-relax-tangent-gradient (CPU) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `tangent_gradient_from_soa_field_into` |
| eq-fdm-relax-tangent-gradient (CUDA host loop) | `crates/fullmag-runner/src/relaxation/vector_math.rs` | `tangent_gradient_from_field` |
| eq-fdm-relax-max-torque | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `compute_max_torque_soa` |
| eq-fdm-relax-energy-metric | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `energy_metric_dot` |
| eq-fdm-relax-retraction | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `normalized_direct_spin` |
| eq-fdm-relax-overdamped-llg | `crates/fullmag-runner/src/relaxation/convergence.rs` | `llg_overdamped_uses_pure_damping` |
| eq-fdm-relax-armijo-chord | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `fdm_representable_chord_energy_linear_increment_soa` |
| eq-fdm-relax-armijo-acceptance | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `projected_gradient_armijo_accepts_with_tolerance` |
| eq-fdm-relax-pgbb-update, eq-fdm-relax-bb-secant, eq-fdm-relax-bb-steps (CPU) | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_projected_gradient_bb_soa` |
| eq-fdm-relax-bb-secant, eq-fdm-relax-bb-steps (CUDA) | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `projected_gradient_step_size_update` |
| eq-fdm-relax-bb-reset | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `fallback_bb_reset_step_size` |
| eq-fdm-relax-ncg-transport, eq-fdm-relax-ncg-beta, eq-fdm-relax-ncg-direction (CPU) | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_nonlinear_cg_soa` |
| eq-fdm-relax-ncg-beta, eq-fdm-relax-ncg-direction (CUDA) | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `nonlinear_cg_next_direction` |
| eq-fdm-relax-ncg-initial-step | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `nonlinear_cg_initial_step_size` |
| eq-fdm-relax-tolerance-lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `DEFAULT_RELAXATION_TORQUE_TOLERANCE_T` |
| eq-fdm-relax-stop | `crates/fullmag-runner/src/relaxation/convergence.rs` | `RelaxationTorqueConfirmation` |
| SoA/AoS dispatch and rejection reasons | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `soa_fast_path_rejection_reason` |
| CPU realization provenance | `crates/fullmag-runner/src/relaxation/provenance.rs` | `cpu_direct_minimizer_realization` |
| final-artifact realization check | `crates/fullmag-runner/src/relaxation/provenance.rs` | `expected_cpu_direct_minimizer_realization` |
| CUDA direct-minimizer loop | `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs` | `execute_direct_minimizer` |
| CUDA Frozen Spins rejection and CUDA provenance | `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs` | `execute_cuda_fdm`, `#[cfg(feature = "cuda")]` variant (the other variant is the no-CUDA stub, so this anchor is not in the source map) |
| FDM algorithm gate | `crates/fullmag-plan/src/validate.rs` | `planned_study_controls` |
| multilayer gate | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` |
| Python stage API and lowering | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` |

(fdm-relax-validation)=
## 10. Validation

Evidence class for every row: source-level unit or contract test. None of these
tests is a managed runtime, GPU device, or scientific qualification receipt.
Under the current repository rule unit tests are not compiled in this change;
their status is taken from the existing CI `rust-contracts` job.

| Test | Path | Lane | Assertion |
|---|---|---|---|
| `bb_relaxation_stops_on_uniform_state` | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | FDM CPU | PG-BB completes on equilibrium input and records the CPU realization |
| `ncg_relaxation_stops_on_uniform_state` | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | FDM CPU | NCG completes on equilibrium input |
| `bb_relaxation_decreases_energy_on_random_initial` | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | FDM CPU | $E_{\mathrm{final}}\le E_{\mathrm{initial}}$ |
| `ncg_relaxation_decreases_energy_on_random_initial` | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | FDM CPU | $E_{\mathrm{final}}\le E_{\mathrm{initial}}$ |
| `all_algorithms_converge_to_similar_equilibrium` | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | FDM CPU | LLG, PG-BB, and NCG energies agree within 20 % |
| `llg_overdamped_relaxation_stops_before_time_limit_on_uniform_state` | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | FDM CPU | LLG relaxation stops early on equilibrium input |
| `projected_gradient_bb_soa_matches_aos_reference_path` | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | FDM CPU | SoA and AoS PG-BB kernels agree |
| `nonlinear_cg_soa_matches_aos_reference_path` | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | FDM CPU | SoA and AoS NCG kernels agree |
| `armijo_uses_representable_retraction_chord` | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | FDM CPU/GPU shared | acceptance uses the stored chord, not the analytic slope |
| `single_precision_armijo_uses_bounded_energy_roundoff_budget` | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | FDM GPU FP32 | bounded $\varepsilon_E$ only in single precision |
| `cpu_fdm_realization_follows_problem_soa_rejection` | `crates/fullmag-runner/src/relaxation/provenance.rs` | FDM CPU | SoA/AoS realization mapping from the recorded layout |
| `total_energy_helpers_include_local_conservative_terms` | `crates/fullmag-engine/src/lib.rs` | FDM CPU | direct-minimizer energy matches full observables for anisotropy and magnetoelastic terms |

Not verified for this page: execution of the section 6 example, CPU/GPU parity
of accepted states, FP32 qualification, and runtime final provenance of the
CUDA direct-minimizer lane.

(fdm-relax-limitations)=
## 11. Limitations

1. No thermal relaxation, simulated annealing, or Langevin noise.
2. No saddle-search methods (NEB, string, dimer).
3. No manifold L-BFGS. A future variant needs Wolfe line search, $O(kN)$
   history memory, and cautious Hessian updates on the manifold.
4. Fixed internal parameters (section 5.6) are not exposed in `ProblemIR`.
5. Normalization retraction and projection transport are first order.
6. Multilayer PG-BB/NCG are not executable; only `llg_overdamped` is.
7. NCG line search is Armijo-only; cubic interpolation is not implemented.
8. FDM CUDA BB/NCG reject Frozen Spins and heterogeneous cellwise materials.
9. FDM CUDA BB/NCG final provenance: source inspection shows no requested,
   resolved, or realization field is written by the CUDA FDM provenance
   builder, while final-artifact validation expects them. Runtime behaviour is
   not verified here and needs a managed CUDA run.
10. With Frozen Spins, the CPU minimizers include frozen cells in the gradient
    norms and in the $\tau_{\max}$ reduction, although those cells cannot move.
    A frozen cell with a nonzero torque can therefore keep $\tau_{\max}$ above
    the tolerance, and the run ends as `numerical_stagnation` instead of
    convergence. Excluding frozen cells is a solver change outside this note.
11. No relaxation lane holds a source-bound managed qualification receipt.

(fdm-relax-scientific-bibliography)=
## 12. Scientific bibliography

1. J. Barzilai and J. M. Borwein, "Two-point step size gradient methods,"
   *IMA J. Numer. Anal.* 8(1), 141–148 (1988).
   doi:[10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141)
2. L. Exl et al., "LaBonte's method revisited: An effective steepest descent
   method for micromagnetic energy minimization," *J. Appl. Phys.* 115, 17D118
   (2014). doi:[10.1063/1.4862839](https://doi.org/10.1063/1.4862839)
3. S. Lepadatu, "Boris computational spintronics — High performance multi-mesh
   magnetic and spin transport modeling software," *J. Appl. Phys.* 128, 243902
   (2020). doi:[10.1063/5.0024382](https://doi.org/10.1063/5.0024382)
4. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR
   6376, National Institute of Standards and Technology (1999).
   doi:[10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376)
5. J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer
   (2006). doi:[10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5)
6. P.-A. Absil, R. Mahony, and R. Sepulchre, *Optimization Algorithms on Matrix
   Manifolds*, Princeton University Press (2008).
7. E. Polak and G. Ribière, "Note sur la convergence de méthodes de directions
   conjuguées," *RIRO* 3(16), 35–43 (1969).
8. µMAG Standard Problem #4, NIST,
   https://www.ctcms.nist.gov/~rdm/mumag.org.html

(fdm-relax-source-code-index)=
## 13. Source-code index

| Path | Symbol | Responsibility | Lane | Tests | Evidence status |
|---|---|---|---|---|---|
| `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs` | `total_energy_from_soa_ws` | total conservative energy for line-search trials | FDM CPU | `total_energy_helpers_include_local_conservative_terms` | source-test |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `effective_field_into_soa_ws` | accepted-state effective field | FDM CPU | `bb_relaxation_stops_on_uniform_state` | source-test |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `tangent_gradient_from_soa_field_into` | tangent gradient | FDM CPU | `bb_relaxation_decreases_energy_on_random_initial` | source-test |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `soa_fast_path_rejection_reason` | SoA admission and rejection reasons | FDM CPU | `projected_gradient_bb_soa_matches_aos_reference_path` | source-test |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `llg_rhs_from_field` | LLG RHS with optional precession | FDM CPU | `llg_overdamped_relaxation_stops_before_time_limit_on_uniform_state` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_projected_gradient_bb` | SoA/AoS PG-BB dispatch | FDM CPU | `projected_gradient_bb_soa_matches_aos_reference_path` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_projected_gradient_bb_soa` | PG-BB loop, transported secant, BB alternation | FDM CPU | `bb_relaxation_decreases_energy_on_random_initial` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_nonlinear_cg` | SoA/AoS NCG dispatch | FDM CPU | `nonlinear_cg_soa_matches_aos_reference_path` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_nonlinear_cg_soa` | NCG loop, PR+ coefficient, restart | FDM CPU | `ncg_relaxation_decreases_energy_on_random_initial` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `fallback_bb_reset_step_size` | BB reset step | FDM CPU | `bb_relaxation_decreases_energy_on_random_initial` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `normalized_direct_spin` | retraction with Frozen Spins and inactive cells | FDM CPU | `projected_gradient_bb_soa_matches_aos_reference_path` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `compute_max_torque_soa` | canonical torque residual | FDM CPU | `bb_relaxation_stops_on_uniform_state` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `fdm_representable_chord_energy_linear_increment_soa` | Armijo chord increment | FDM CPU | `armijo_uses_representable_retraction_chord` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `energy_metric_dot` | energy metric product | FDM GPU host loop | `armijo_uses_representable_retraction_chord` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `projected_gradient_armijo_accepts_with_tolerance` | Armijo acceptance | FDM CPU/GPU | `single_precision_armijo_uses_bounded_energy_roundoff_budget` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `direct_minimizer_energy_tolerance_j` | FP32 energy budget | FDM GPU | `single_precision_armijo_uses_bounded_energy_roundoff_budget` | source-test |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `projected_gradient_step_size_update` | BB step update | FDM GPU host loop | none dedicated | source-inspection |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `nonlinear_cg_next_direction` | PR+ direction update | FDM GPU host loop | none dedicated | source-inspection |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `nonlinear_cg_initial_step_size` | NCG first trial step | FDM GPU host loop | none dedicated | source-inspection |
| `crates/fullmag-runner/src/relaxation/vector_math.rs` | `tangent_gradient_from_field` | tangent gradient from copied device field | FDM GPU host loop | none dedicated | source-inspection |
| `crates/fullmag-runner/src/relaxation/convergence.rs` | `RelaxationTorqueConfirmation` | three-sample torque confirmation | FDM CPU/GPU | `ncg_relaxation_stops_on_uniform_state` | source-test |
| `crates/fullmag-runner/src/relaxation/convergence.rs` | `llg_overdamped_uses_pure_damping` | disables precession for LLG relaxation | FDM CPU/GPU | `llg_overdamped_relaxation_stops_before_time_limit_on_uniform_state` | source-test |
| `crates/fullmag-runner/src/relaxation/provenance.rs` | `cpu_direct_minimizer_realization` | CPU realization from the SoA predicate | FDM CPU | `cpu_fdm_realization_follows_problem_soa_rejection` | source-test |
| `crates/fullmag-runner/src/relaxation/provenance.rs` | `expected_cpu_direct_minimizer_realization` | expected realization from recorded layout | FDM CPU | `cpu_fdm_realization_follows_problem_soa_rejection` | source-test |
| `crates/fullmag-runner/src/relaxation/provenance.rs` | `apply_energy_minimizer_provenance` | requested/resolved minimizer fields | FDM CPU | `bb_relaxation_stops_on_uniform_state` | source-test |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_terminal_context` | CPU dispatch and provenance assembly | FDM CPU | `all_algorithms_converge_to_similar_equilibrium` | source-test |
| `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs` | `execute_direct_minimizer` | CUDA host-orchestrated BB/NCG loop | FDM GPU | none dedicated | source-inspection |
| `crates/fullmag-runner/src/artifacts.rs` | `validate_direct_minimizer_realization` | final-artifact realization check | FDM CPU/GPU | `cpu_fdm_realization_follows_problem_soa_rejection` | source-test |
| `crates/fullmag-plan/src/validate.rs` | `planned_study_controls` | FDM algorithm gate | FDM CPU/GPU | planner contract tests | source-inspection |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | multilayer llg_overdamped-only gate | FDM CPU/GPU multilayer | planner contract tests | source-inspection |
| `crates/fullmag-ir/src/execution.rs` | `RelaxationAlgorithmIR` | algorithm enum | all | IR contract tests | source-inspection |
| `crates/fullmag-ir/src/study.rs` | `RelaxStopIR` | canonical stop fields | all | IR contract tests | source-inspection |
| `crates/fullmag-ir/src/plan.rs` | `RelaxationControlIR` | plan relaxation control | all | IR contract tests | source-inspection |
| `crates/fullmag-ir/src/lib.rs` | `validate_study_contracts` | dynamics and stop validation | all | IR contract tests | source-inspection |
| `packages/fullmag-py/src/fullmag/world.py` | `add_relax` | stage-first relax builder | FDM CPU/GPU | Python API tests | example lowering executed |
| `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | stage spec and validation | FDM CPU/GPU | Python API tests | example lowering executed |
| `packages/fullmag-py/src/fullmag/world.py` | `_build_relax_llg_dynamics` | LLG-only controls and rejection | FDM CPU/GPU | Python API tests | example lowering executed |
| `packages/fullmag-py/src/fullmag/world.py` | `_resolve_flat_relax_stop` | tolT/tolA/stop resolution | FDM CPU/GPU | Python API tests | example lowering executed |
| `packages/fullmag-py/src/fullmag/world.py` | `_relax_problem_from_spec` | stage problem and relax_alpha damping | FDM CPU/GPU | Python API tests | example lowering executed |
| `packages/fullmag-py/src/fullmag/model/study.py` | `class RelaxStop` | stop validation and IR lowering | FDM CPU/GPU | Python API tests | example lowering executed |
| `packages/fullmag-py/src/fullmag/model/study.py` | `DEFAULT_RELAXATION_TORQUE_TOLERANCE_T` | default tolT | FDM CPU/GPU | Python API tests | example lowering executed |
