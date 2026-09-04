
# Relaxation algorithms for FEM micromagnetics on MFEM/libCEED/hypre with GPU

- Status: executable implementation paths for LLG/PG-BB/NCG; qualification
  remains unvalidated; TPI under development
- Owners: Fullmag core
- Last updated: 2026-09-04
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
  - `docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md`
  - `docs/physics/0500-fdm-relaxation-algorithms.md`
  - `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
  - `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`

The cross-layer equilibrium, legality, observable, and completion contract is
canonical in `0580`. This note retains FEM implementation and qualification
detail; any conflicting historical statement here is superseded by `0580`.

(fem-relaxation-problem-statement)=
## 1. Problem statement

This note defines the current FEM relaxation / energy-minimization algorithms
and the remaining roadmap beyond explicit damped LLG alone.

Current repo status relevant to this note:

- the planner can construct a `FemPlanIR` from a precomputed `MeshIR`,
- `FemPlanIR` already carries mesh data, per-node initial magnetization, material payload,
  active term flags, precision, and LLG timing parameters,
- the runner executes FEM relaxation through the maintained native FEM lanes,
- `StudyIR::Relaxation` exists. `llg_overdamped`, `nonlinear_cg`, and
  `projected_gradient_bb` have executable FEM demag paths at
  `rtol<=1e-12`; this source-level availability is not a production
  qualification. PG-BB uses direct polarized Armijo increments and never
  substitutes NCG silently. A fresh source-bound managed receipt is still
  required before any lane is promoted.
  `tangent_plane_implicit` is a CPU/MFEM development capability only:
  strict mode and forced GPU reject it, while extended mode may resolve it to
  CPU/MFEM with explicit requested/resolved provenance,
- native CPU/MFEM owns executable FEM `projected_gradient_bb` without demag and
  FEM `nonlinear_cg` with or without demag through the
  `fullmag_fem_backend_relax_step` ABI, using
  tangent gradients, Armijo line search, sphere retraction, FEM lumped-mass
  inner products, and exchange-plus-mass preconditioned gradient directions
  with serial MFEM CG as the current default. HyprePCG/BoomerAMG remains an
  explicit opt-in qualification path via
  `FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER=hypre`,
- native CPU/MFEM carries the development FEM
  `tangent_plane_implicit` path through the same ABI; it solves a global tangent-plane linear system with
  `mass + step * exchange` plus local uniaxial/cubic anisotropy, Zeeman tangent
  curvature, and matrix-free DMI weak-residual and demag fresh-solve actions,
  while nonconservative torques, stochastic fields, time-dependent terms, and
  interactions without matched field/energy realizations are rejected before
  every relaxation algorithm,
- GPU/libCEED residual kernels, broader preconditioning policy, and
  full-device-resident tangent-plane solves are under development, not
  runner-owned fallback paths.
- native CUDA `projected_gradient_bb` building-block kernels now live under
  `backends/fem/gpu/cuda/relaxation/`: tangent-gradient projection from
  `H_eff`, FEM lumped-mass metric reductions, and normalized nodal retraction.
  `pgbb.cpp` also owns the native GPU PG-BB preflight/step boundary reached
  from `run_backend_relaxation_step` when a GPU state is allocated. The CUDA
  branch contains the device-resident Armijo accepted-step loop and BB1/BB2
  step-size update. The native GPU path carries PG-BB on `fem_native_gpu`,
  including demag workloads at `rtol<=1e-12`, subject to capability and
  runtime gates. Runtime provenance keeps controlled compute scalar
  readbacks for Armijo/BB decisions distinct from rejected exchange hot-loop
  host sync.
- native CUDA `nonlinear_cg` now lives under
  `backends/fem/gpu/cuda/relaxation/`: it owns device-resident tangent-gradient
  reduction, FEM mass-metric dot products, normalized retraction, Armijo
  accepted-step loop, persistent search-direction state, PR+ update, rollback,
  and the native GPU NCG preflight/step boundary reached from
  `run_backend_relaxation_step` when a GPU state is allocated.
- runner capability checks keep `tangent_plane_implicit` CPU/MFEM
  development-only. Strict mode and every forced GPU request reject. Only
  extended automatic selection may resolve TPI to the CPU/MFEM development
  lane, with explicit warning and requested/resolved provenance; no hidden
  GPU-to-CPU fallback is legal while the full GPU/libCEED device-resident
  tangent-plane solve remains under development.

Shared stop/refresh semantics now live in
`0530-shared-relaxation-stop-and-field-refresh-semantics.md`. This note focuses
on how those shared controls are interpreted by the FEM stack.

For FEM, relaxation is especially important because:

- curved geometries and open-boundary demag often make static equilibria the main target,
- explicit dynamic integration can be severely stiffness-limited,
- FE operators admit strong preconditioning and tangent-space linearization strategies.

Recommended algorithm families:

1. overdamped LLG with adaptive explicit integrator,
2. projected gradient / Barzilai–Borwein on FE nodal spheres,
3. nonlinear conjugate gradient with FE-aware preconditioning,
4. tangent-plane linearly implicit relaxation on CPU/MFEM,
5. later: manifold L-BFGS or Newton-like methods.

(fem-relaxation-governing-equations)=
## 2. Physical model

### 2.1 Constrained minimization

The equilibrium problem is

```{math}
:label: fem-relaxation-equilibrium-minimization
\min_{m_h \in V_h^3,\ |m_h(\mathbf{x})| \approx 1} E[m_h].
```

In discrete DOFs, the tangent gradient is represented by the FE residual projected through the mass operator.

For a discrete state `u`, define the FE gradient `g(u)` through

```{math}
:label: fem-relaxation-fe-gradient
M g(u) = -G(u),
```

where `G(u)` is the assembled energy residual and `M` is the vector mass operator.

The tangent projection at nodal/DOF level must remain exact for the
representable state stored by the solver. Although nodal retraction targets a
unit vector, binary64 normalization can leave
$m_i\mathbin{\cdot}m_i\ne 1$ by one or more ulps. Therefore the canonical
projector is

```{math}
:label: fem-relaxation-tangent-projection
P_m v = v-m\frac{m\mathbin{\cdot}v}{m\mathbin{\cdot}m},
\qquad
g_T=P_m g,
```

interpreted cellwise / nodewise according to the chosen DOF layout. Replacing
the denominator by one is not equivalent in floating-point arithmetic: a
longitudinal field can otherwise create a spurious non-orthogonal gradient
whose squared norm pollutes the Armijo slope.

For normalization retraction

```{math}
:label: fem-relaxation-normalization-retraction
R_m(\lambda p)=\frac{m+\lambda p}{\lVert m+\lambda p\rVert},
```

the actual derivative at the representable base state is

```{math}
:label: fem-relaxation-retraction-derivative
\left.\frac{dR_m(\lambda p)}{d\lambda}\right|_{\lambda=0}
=\frac{P_m p}{\lVert m\rVert}.
```

Consequently a line-search directional derivative must use this retraction
derivative, including the per-node $1/\lVert m_i\rVert$ factor; it must not
silently substitute the ambient direction. Zero-norm magnetic states remain
invalid input and are not repaired by a tolerance or projector fallback.
The binary64 projector evaluates the denominator explicitly and applies one
unconditional residual reprojection, again with the same denominator, so the
stored result is orthogonal to the stored `m` even when the first subtraction
loses low bits. This is algebraically the same projector, not a stopping
tolerance.

For an actual production trial, the sufficient-decrease owner uses the
representable chord

```{math}
:label: fem-relaxation-representable-chord
s_i=R_{m_i}(\lambda p_i)_{\mathrm{fp}}-m_i
```

and the current ambient energy gradient:

```{math}
:label: fem-relaxation-chord-linear-increment
\Delta E_{\mathrm{lin,fp}}
=-\mu_0\sum_i M_{s,i}V_i
 H_{\mathrm{eff},i}(m)\mathbin{\cdot}s_i.
```

The strict Armijo threshold is
$c_1\Delta E_{\mathrm{lin,fp}}$, and a trial is eligible only when this
quantity is finite and strictly negative. A zero/non-descent chord is rejected;
an unchanged chord is never accepted. For a unit state and tangent direction
in exact arithmetic, $s=\lambda p+O(\lambda^2)$, so the rule recovers the
classical $c_1\lambda\phi'(0)$ threshold. The representable form is required
because binary64 normalization can leave one component bitwise fixed even when
the analytic retraction derivative has a nonzero component. No norm, energy,
or component tolerance is introduced.

### 2.2 Torque and stopping criteria

Use physically meaningful stopping criteria:

- max torque norm,
- total-energy plateau range over a sufficiently long accepted-step window,
- norm defect,
- optionally projected residual norm.

Do **not** treat one small step-to-step energy delta as relaxation. The native
FEM energy stop uses the shared 50 accepted-step plateau rule from
`0530-shared-relaxation-stop-and-field-refresh-semantics.md`: stop with
`reason=energy` only when `max(E)-min(E)` across the last 50 accepted relax
steps is below `energy_tolerance_j`, and when any configured torque tolerance is
also satisfied.

For shared product semantics with the current FDM runner, the public
`torque_tolerance` control is expressed in `A/m` as
`max |m × H_eff|`. A derived `max_torque_T = μ0 * max_torque_Apm` observable may
still be surfaced for mumax-style comparability, but it is auxiliary and must
not replace the canonical stop threshold.
The accepted-state field reduction publishes exact `max_torque_Apm` in `A/m`,
including exact zero. `max_torque_T = mu0 * max_torque_Apm` is the equivalent
induction residual in `T`, not mechanical torque. `max_rhs_norm_per_s` is the
separate `max |dm/dt|` dynamic observable in `1/s`; no stop path reconstructs
field torque from it.

(fem-relaxation-symbols-and-si-units)=
### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| $m_h$ | discrete reduced magnetization | $1$ |
| $V_h^3$ | discrete vector finite-element space | $1$ |
| $\mathbf{x}$ | spatial position | $\mathrm{m}$ |
| $i$ | active nodal index | $1$ |
| $k$ | accepted direct-minimizer iteration index | $1$ |
| $n$ | tangent-plane iteration index | $1$ |
| $E$ | total micromagnetic energy | $\mathrm{J}$ |
| $u$ | FE DOF vector for reduced magnetization | $1$ |
| $G(u)$ | assembled field residual | $\mathrm{A\,m^2}$ |
| $M$ | vector mass operator | $\mathrm{m^3}$ |
| $M_L$ | lumped vector mass operator | $\mathrm{m^3}$ |
| $g(u)$ | tangent field gradient $-P_mH_{\mathrm{eff}}$ | $\mathrm{A\,m^{-1}}$ |
| $g$ | ambient tangent-gradient field | $\mathrm{A\,m^{-1}}$ |
| $g_i$ | tangent gradient at node $i$ | $\mathrm{A\,m^{-1}}$ |
| $g_k$ | tangent-gradient field at accepted iteration $k$ | $\mathrm{A\,m^{-1}}$ |
| $g_T$ | projected tangent gradient | $\mathrm{A\,m^{-1}}$ |
| $P_m$ | exact projector for the representable nodal state | $1$ |
| $P_{m_i}$ | exact projector at representable node $i$ | $1$ |
| $P_{m_k}$ | exact projector at accepted state $m_k$ | $1$ |
| $m$ | representable reduced magnetization | $1$ |
| $m_i$ | representable reduced magnetization at node $i$ | $1$ |
| $m_k$ | accepted reduced-magnetization state at iteration $k$ | $1$ |
| $m_{k-1}$ | previous accepted reduced-magnetization state | $1$ |
| $m_n$ | tangent-plane base state at iteration $n$ | $1$ |
| $m_{n+1}$ | tangent-plane updated state | $1$ |
| $m_0,m_1$ | current and trial endpoint states | $1$ |
| $m_{0,i},m_{1,i}$ | current and trial endpoint states at node $i$ | $1$ |
| $v$ | field-like vector projected by $P_m$ | $\mathrm{A\,m^{-1}}$ |
| $p$ | production PG-BB/NCG search direction | $\mathrm{A\,m^{-1}}$ |
| $p_i$ | production search direction at node $i$ | $\mathrm{A\,m^{-1}}$ |
| $\lambda$ | production line-search step in $R_m(\lambda p)$ | $\mathrm{m\,A^{-1}}$ |
| $R_m$ | normalization retraction at state $m$ | $1$ |
| $R_{m_i}$ | nodal normalization retraction at state $m_i$ | $1$ |
| $R_{m_n}$ | tangent-plane normalization retraction at state $m_n$ | $1$ |
| $s_i$ | representable retraction chord at node $i$ | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | nodal saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | lumped nodal volume | $\mathrm{m^3}$ |
| $H_{\mathrm{eff},i}$ | nodal effective field | $\mathrm{A\,m^{-1}}$ |
| $H_{\mathrm{eff},i}(m)$ | nodal effective field evaluated at state $m$ | $\mathrm{A\,m^{-1}}$ |
| $u^{\mathrm{trial}}$ | projected-gradient trial state | $1$ |
| $\widetilde{s}_k$ | transported accepted-state chord | $1$ |
| $\widetilde{y}_k$ | transported tangent-gradient difference | $\mathrm{A\,m^{-1}}$ |
| $\widetilde{s}_{k,i}$ | transported accepted-state chord at node $i$ | $1$ |
| $\widetilde{y}_{k,i}$ | transported tangent-gradient difference at node $i$ | $\mathrm{A\,m^{-1}}$ |
| $g_{k-1}$ | previous accepted tangent-gradient field | $\mathrm{A\,m^{-1}}$ |
| $S_{ss}$ | energy-weighted state-chord self product | $\mathrm{J\,m\,A^{-1}}$ |
| $S_{sy}$ | energy-weighted chord-gradient product | $\mathrm{J}$ |
| $S_{yy}$ | energy-weighted gradient self product | $\mathrm{J\,A\,m^{-1}}$ |
| $\gamma_N$ | floating-point reduction error factor | $1$ |
| $N$ | number of active scalar reduction terms | $1$ |
| $\epsilon_{64}$ | binary64 machine epsilon | $1$ |
| $v_n$ | tangent-plane state update | $1$ |
| $\mathcal{T}_{m_n}$ | tangent space at $m_n$ | $1$ |
| $K_A$ | symmetric discrete exchange-energy operator | $\mathrm{J}$ |
| $\Delta E_{\mathrm{ex}}$ | direct exchange-energy increment | $\mathrm{J}$ |
| $\widehat{\Delta E}$ | computed direct total-energy increment | $\mathrm{J}$ |
| $B_{\Delta E}$ | forward-error bound for the direct increment | $\mathrm{J}$ |
| $\Delta E_{\mathrm{upper}}$ | upper endpoint of the direct-increment interval | $\mathrm{J}$ |
| $\Delta E_{\mathrm{lin,fp}}$ | representable-chord linear energy model | $\mathrm{J}$ |
| $c_1$ | Armijo sufficient-decrease coefficient | $1$ |
| $a_i$ | nodal uniaxial easy-axis unit vector | $1$ |
| $s_{k,i}$ | projection $m_{k,i}\mathbin{\cdot}a_i$ | $1$ |
| $s_{0,i},s_{1,i}$ | current and trial uniaxial-axis projections | $1$ |
| $K_{u1,i}$ | first-order uniaxial anisotropy density | $\mathrm{J\,m^{-3}}$ |
| $K_{u2,i}$ | second-order uniaxial anisotropy density | $\mathrm{J\,m^{-3}}$ |
| $\Delta E_{\mathrm{ani}}$ | direct uniaxial-anisotropy increment | $\mathrm{J}$ |
| $H_{d,0,i},H_{d,1,i}$ | current and trial nodal demagnetizing fields | $\mathrm{A\,m^{-1}}$ |
| $\Delta E_d$ | direct demagnetizing-energy increment | $\mathrm{J}$ |
| $q$ | tangent direction used by the derivative oracle | $1$ |
| $\tau$ | field torque residual $m\mathbin{\times}H_{\mathrm{eff}}$ | $\mathrm{A\,m^{-1}}$ |
| $\mathrm{fp}$ | floating-point evaluation marker | $1$ |
| $\min$ | constrained minimization operator | $1$ |
| $\sum_i$ | sum over active magnetic nodes | $1$ |
| $\mathbin{\cdot}$ | Euclidean dot-product operator | $1$ |
| $\lVert\cdot\rVert$ | Euclidean norm operator | $1$ |
| $(\cdot)^T$ | algebraic transpose operator | $1$ |
| $\frac{d}{d\lambda}$ | derivative with respect to the line-search step | $\mathrm{A\,m^{-1}}$ |
| $|\cdot|$ | Euclidean magnitude operator | $1$ |
| $\approx$ | approximate-equality relation | $1$ |
| $\in$ | set-membership relation | $1$ |
| $\le$ | non-strict ordering relation | $1$ |
| $<$ | strict ordering relation | $1$ |

(fem-relaxation-assumptions-and-validity)=
### 2.4 Assumptions and approximations

This note targets deterministic equilibrium search only.
Deferred:

- thermal annealing,
- string / NEB methods,
- saddle search,
- full Newton methods with exact Hessians.

(fem-relaxation-discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

See:

- `0500-fdm-relaxation-algorithms.md`

### 3.2 FEM

#### 3.2.1 Algorithm A — overdamped LLG with adaptive explicit RK

This is the easiest baseline because it reuses the dynamic RHS machinery.
Use adaptive DOPRI54 or similar once explicit RK support exists.

Only `llg_overdamped` owns an RK integrator, `dt`, and a stage-local relaxation
clock in seconds. PG-BB, NCG, and TPI own no RK or physical/pseudo time; their
accepted line-search step is in `m/A`. Direct minimizers report zero stage time
and no synthetic `dt`.

Canonical authoring defaults must also remain aligned across Python and UI.
For `Relaxation`, the public defaults are `torque_tolerance=1e-4 A/m` and
`max_steps=50000`; Python, generated API, UI, and script export share them.
The `dynamics` payload is algorithm-specific: `llg_overdamped` requires it,
while the direct minimizers `projected_gradient_bb` and `nonlinear_cg` must
omit it. Those minimizers own their native search direction and line search;
rejecting an incompatible `dynamics` payload in Python authoring occurs before
ProblemIR construction and is not evidence about native convergence.

Pros:

- minimal new architecture,
- easy user mental model.

Cons:

- can be very stiffness-limited on fine meshes,
- not the best final FEM relaxation strategy.

#### 3.2.2 Algorithm B — projected gradient / BB in FE space

Compute a mass-projected gradient

```{math}
:label: fem-relaxation-lumped-gradient
M_L g = -G(u),
```

preferably with lumped mass for efficient diagonal-mass updates.
Take a projected step

```{math}
:label: fem-relaxation-projected-trial
u^{trial} = u - \lambda g_T,
```

then retract to the nodal sphere constraint.

Use BB step-length formulas with line search and the physical FEM energy
weight. The three concrete products used by BB are

```{math}
:label: fem-relaxation-bb-ss-product
S_{ss}=\mu_0\sum_i M_{s,i}V_i
\widetilde{s}_{k,i}\mathbin{\cdot}\widetilde{s}_{k,i},
```

```{math}
:label: fem-relaxation-bb-sy-product
S_{sy}=\mu_0\sum_i M_{s,i}V_i
\widetilde{s}_{k,i}\mathbin{\cdot}\widetilde{y}_{k,i},
```

and

```{math}
:label: fem-relaxation-bb-yy-product
S_{yy}=\mu_0\sum_i M_{s,i}V_i
\widetilde{y}_{k,i}\mathbin{\cdot}\widetilde{y}_{k,i}.
```
The admissible FEM state is a product of nodal spheres, so successive tangent
gradients must first be compared in the accepted tangent space. With the
normalization retraction, both lanes use the representable-state projection
transport `P_m(v)=v-m(m dot v)/(m dot m)` and form

```{math}
:label: fem-relaxation-transported-bb-secant
\widetilde{s}_k=P_{m_k}(m_k-m_{k-1}),
\qquad
\widetilde{y}_k=g_k-P_{m_k}g_{k-1}.
```

The weighted products of `s_tilde` and `y_tilde` have units `J m/A`, `J`, and
`J A/m` for `ss`, `sy`, and `yy`, respectively, so both BB1 `ss/sy` and BB2
`sy/yy` have the required `m/A` step unit. The CUDA and CPU reductions
accumulate the unscaled physical products. An ambient `g_k-g_{k-1}` or chord
`m_k-m_{k-1}` is not a production BB secant after a retracted step. A shared
absolute floor is forbidden because no single number can have all three
units. For `N=3 n_m` active scalar terms, both lanes instead bound reduction
roundoff with

```{math}
:label: fem-relaxation-roundoff-gamma
\gamma_N = \frac{N\epsilon_{64}}{1-N\epsilon_{64}}.
```

Positive curvature is numerically resolved only when
`sy > gamma_N sqrt(ss yy)`. The square-root scale has units `J`, matching
`sy`; `ss` and `yy` must also be finite and nonnegative. This one guard is
sufficient for both BB quotients because `yy` is a nonnegative sum. The
previous common `1e-6` factor is removed: while it cancelled algebraically in
exact quotients, it changed the meaning of any absolute denominator test.

The production seed and clamp remain `lambda_0=1e-6 m/A` and
`lambda in [1e-15, 1e-3] m/A`. They do not require numerical recalibration:
removing a common factor from both vectors leaves `ss/sy` and `sy/yy`
scale-equivalent apart from roundoff, and the reset divides `lambda_0` only by
a dimensionless failure count. These values are algorithmic step controls,
not dimensionless curvature tolerances.

`cuda_heterogeneous_nodal_ms_pgbb_ncg_calibration` is the named native
calibration workload for this step policy. Its three-entry realized FEM metric
has two active nodes with `Ms={4e5,9e5} A/m` and one masked node containing
large but finite sentinel values. It compares CUDA PG-BB `ss/sy/yy` and the
production CUDA NCG gradient, denominator, numerator, PR+ direction, and
descent product with independent CPU `mu0 Ms_i V_i` arithmetic over active
nodes only. This proves that heterogeneous nodal weights and magnetic-node
mask semantics enter the adaptive BB/PR products consistently while the seed
and clamps retain their `m/A` units. It does not claim discontinuous
sharp-element `Ms` support; that remains owned by `FEM-TD-PHY-MAT-001`.

This is a clean first direct-minimization method for FEM.

#### 3.2.3 Algorithm C — nonlinear CG with FE-aware preconditioning

Use projected gradient plus a conjugate search direction.
Recommended enhancements over the FDM version:

- use FE mass-weighted inner products,
- allow simple preconditioning, e.g. exchange-plus-mass preconditioners,
- include restart logic when conjugacy deteriorates.

This can substantially reduce iteration counts on mesh-based problems.

#### 3.2.4 Algorithm D — tangent-plane linearly implicit relaxation

This is the most important production-target FEM relaxation method.

At state `m_n`, solve for an update `v_n` in the tangent space:

```{math}
:label: fem-relaxation-tangent-plane-constraint
v_n \in \mathcal{T}_{m_n},
\qquad
m_n \cdot v_n = 0,
```

using a linearized or semi-implicit system built from the exchange, demag, DMI, and Zeeman operators.
The current CPU/MFEM implementation includes exchange, local uniaxial/cubic
anisotropy, Zeeman curvature, DMI weak-residual action, and demag fresh-solve
linear response in that implicit tangent operator. The remaining production gap
is the full GPU/libCEED/device-resident tangent-plane solve path, not the
CPU/MFEM demag operator action.
Then update via

```{math}
:label: fem-relaxation-tangent-plane-update
m_{n+1} = R_{m_n}(v_n),
```

with a norm-preserving retraction.

Why this is the right production direction for FEM:

- better stiffness handling,
- natural compatibility with sparse / matrix-free FE solvers,
- preconditioning via hypre becomes meaningful,
- geometry of `|m|=1` is handled more honestly than by raw explicit RK.

Recommended software stack:

- MFEM for operator blocks and tangent-space constraints,
- libCEED for local operator application,
- hypre CG / GMRES + preconditioners for linear solves.

#### 3.2.5 Algorithm E — manifold L-BFGS / quasi-Newton (later)

A strong later option once gradient and tangent-space infrastructure are stable.
Likely very effective near equilibrium, but implementation is more involved.

#### 3.2.6 Recommended rollout order

1. Overdamped LLG + adaptive explicit RK.
2. Projected gradient + BB.
3. Nonlinear CG.
4. Tangent-plane linearly implicit relaxation.
5. Later: manifold L-BFGS.

If the project prioritizes serious FEM equilibrium quality over quick parity with FDM,
swap steps 3 and 4.

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

(fem-relaxation-python-api)=
### 4.1 Python API surface

Recommended study object shared with FDM:

```python
# %%
import fullmag as fm

study = fm.study("fem_relaxation")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

# %%
film = study.geometry(
    fm.Box(size=(80e-9, 40e-9, 8e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange(enabled=True)

# %%
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolA=1.0e-4,
)
```

Backend-neutral user API; FE-specific solver/preconditioner knobs belong in
execution hints or backend policy, not in the top-level public object.

Current executable subset (FEM backend; not production-qualified without a
fresh source-bound managed receipt):

- `algorithm = "llg_overdamped"`
- `algorithm = "projected_gradient_bb"`
- `algorithm = "nonlinear_cg"`

`algorithm = "tangent_plane_implicit"` remains under development. It has a
native CPU/MFEM implementation path for development and compatibility checks,
but it is not part of the production-qualified relaxation set and its
GPU/libCEED device-resident tangent-plane solve remains under development.

Status 2026-06-04: native CPU/MFEM direct-relaxation runs publish
`requested_energy_minimizer`, `resolved_energy_minimizer`, and
`energy_minimizer_realization = "native_mfem_backend_relax_step"`, and clear
`resolved_integrator` so metadata does not imply that Heun/RK time integration
executed the stage. The Rust runner selects the native ABI and owns stage
orchestration, artifacts, provenance, and live updates; it does not own FEM
line-search or tangent-plane algorithms.

For FEM/MFEM/CUDA/hypre/libCEED runtime proof, host-side `cargo`, `cmake`, and
direct native binaries are only smoke checks. Managed container-backed `just`
recipes are the authoritative gate; use `just ensure-managed-fem-runtime` for
runtime freshness and `just fem-gpu-headless ...` for executable GPU relaxation
smoke coverage. The managed relaxation smoke validator requires monotone
`E_total`, finite final energy, valid magnetization norm defect, matching
runtime provenance/qualification metadata, and at least `1.0e-3` relative
energy decrease across the smoke trajectory. It also rejects runs where final
`max_torque_T` grows beyond `1.25x` the initial value, allowing short-line-search
torque fluctuations while catching non-relaxing or unstable trajectories.
Use `just verify-fem-relaxation-convergence` for the longer managed
container-backed LLG/PG-BB/NCG convergence gate; it raises the default run to 16
steps and requires at least `1.0e-2` relative energy decrease. Set
`FULLMAG_FEM_RELAXATION_KEEP_LOGS=1` when the runtime logs need to be preserved
as audit evidence for a local verification run.
Use `just verify-fem-relaxation-cpu-gpu-consistency-smoke` for the focused
Box500 exchange-only CPU/GPU consistency slice. It exercises the existing FEM
benchmark runner with a deterministic heun relaxation case across the active
active algorithms `llg_overdamped`, `projected_gradient_bb`,
and `nonlinear_cg`. The smoke requires a separate CPU/GPU pair for each active
active algorithm and intentionally excludes `tangent_plane_implicit`
because that method remains under development. It is a parity smoke, not a
replacement for the broader benchmark matrix.
Use `just verify-fem-relaxation-production-benchmark` for the broader managed
container-backed interaction-matrix gate. It runs the deterministic Box500
airbox CPU/GPU consistency preset across exchange, Zeeman, demag, anisotropy,
DMI, and STT/Oersted scenario families for the current active algorithms.
It requires per-algorithm CPU/GPU pairs for the active algorithms and strict
managed FEM runtime availability. These contracts and smokes do not replace
the FM-RELAX-017 source-bound receipt, mesh-refinement, repeatability,
independent-oracle, and FP32 gates.
The benchmark authoring path must preserve that same algorithm-specific
contract: it passes `dynamics` only for `llg_overdamped` and constructs PGBB or
NCG without `dynamics`. A matrix row rejected by this authoring validation has
not reached the managed native runtime and cannot be counted as an Armijo,
energy-monotonicity, or CPU/GPU physics result.

Current FEM caveat: `projected_gradient_bb` and `nonlinear_cg` use FEM
lumped-mass inner products and native Armijo line search on both maintained
lanes. The CPU/MFEM lane uses exchange-plus-mass preconditioned gradients; the
preconditioner uses serial MFEM CG with a Gauss-Seidel smoother by default.
HyprePCG/BoomerAMG is kept as an explicit opt-in qualification path via
`FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER=hypre`. The native CUDA lane
publishes `gradient_policy = "device_tangent_gradient"` in
`fem_gpu_relaxation_qualification`, because it uses device-resident tangent
gradient kernels rather than the CPU/MFEM preconditioner. `tangent_plane_implicit` is executable on the
native CPU/MFEM lane through a global tangent-plane `mass + step * exchange`
solve; it includes local anisotropy, Zeeman curvature, DMI weak-residual
action, and demag fresh-solve linear response in the implicit operator, but is
not yet a GPU/libCEED-resident tangent-plane solver.

The 2026-09-04 source audit narrows the GPU preconditioner statement further.
The current class named `GpuDiagonalRelaxationPreconditioner` receives only mass and
exchange diagonals and applies $M_i/(M_i+wK_{ii})$ pointwise. It is therefore a
diagonal/Jacobi approximation, not the full sparse $(M+wK)^{-1}M$ operation.
Its setup is not wired into production NCG or PG-BB, the current call sites do
not propagate apply failure, and the benchmark keeps `exchange_mass`
unavailable. The approved full-CSR fixed-CG4/CG8 remediation is documented in
note 0581, but capability, runtime, physics validation, CPU/GPU parity, and
performance remain `NOT VERIFIED`. The production default remains `none`.

Both CPU/MFEM and CUDA direct-minimizer Armijo loops require the sufficient
decrease inequality. The comparison is evaluated as the directly reduced
increment `Delta E = E_trial - E_current`, rather than by comparing two
published total-energy scalars. This avoids losing a physical decrement near
`1e-31 J` while the total energy contains an unrelated `1e-17 J` offset. A
bounded recovery may accept a finite trial only when `Delta E <= 0` under the
same direct-increment oracle; it never accepts a representable energy
increase. This intentionally removes the former
`max(1e-23 J, 1e-12 max(|E_current|,|E_trial|))` window, whose absolute branch
was scale dependent and whose relative branch still changed the physical
monotonicity contract.

#### 3.2.1 Term-complete direct increments

The phrase "directly reduced increment" requires a term-complete numerical
contract. Every enabled discrete energy term is classified exactly once as a
direct increment or an explicit endpoint residual. A directly replaced term
must not also participate in endpoint-total subtraction. Any endpoint residual
must carry a subtraction-error scale derived from the magnitudes of its base
and trial operands, not from the already cancelled residual.

For the symmetric discrete CPU exchange operator `K_A`, PG-BB evaluates

```{math}
:label: fem-relaxation-polarized-exchange-increment
\Delta E_{\mathrm{ex}}=(m_1-m_0)^T K_A(m_1+m_0),
```

using the same energy normalization and SI-joule convention as the canonical
exchange owner. This polarized identity remains accurate near an exchange
nullspace where separately accumulated endpoint energies cannot resolve the
descent. The reduction also reports a componentwise absolute-term sum for its
forward-error bound.

The CUDA direct-increment batch classifies every `GpuFinalScalarSlot` from the
enabled `Context` semantics. Exchange, polarized demag, external Zeeman,
uniaxial anisotropy, and interfacial/bulk DMI use qualified direct identities
exactly once. The current local direct kernel does not consume `H_drive`, so an
enabled regional drive uses its already-reduced endpoint scalar; cubic
anisotropy and magnetoelastic energy use the same explicit endpoint-residual
route. Each residual contributes `trial_q - base_q` and
`abs(trial_q) + abs(base_q)` to the operand-scale bound. The Robin boundary
diagnostic is not a separate Armijo energy because the polarized demag identity
already includes that variational boundary form. Disabled terms and observable
slots are excluded, and an unclassified energy semantic fails closed. This
prevents cancellation of a physical `1e-39 J` decrement by unrelated endpoint
totals of order `1e-17 J`.

The Armijo inequality, `c1`, BB1/BB2, restart, fresh-zero demag, rollback, and
torque/energy tolerances do not change. PG-BB and NCG use the same
term-complete direct-increment owner and the same representable-chord right-hand
side for every initial, preconditioned-restart, and raw-gradient-restart trial.
The NCG search direction and PR+ update remain NCG-owned; sharing the Armijo
oracle does not substitute PG-BB or accept a failed NCG step as success. A
resolved uphill interval is rejected.
An interval overlapping the Armijo threshold is refined by a supported
uncertain owner or fails as numerical stagnation/non-convergence after state
restoration. No energy noise window or absolute raw-gradient threshold is
introduced. The authoritative design and qualification contract is
`docs/superpowers/specs/2026-07-23-fem-direct-armijo-energy-increments-design.md`.

#### 3.2.2 Accepted-step Armijo proof telemetry

Every accepted CPU/MFEM or CUDA PG-BB or NCG line-search step must export
`accepted_energy_proof_available=true` and the exact decision quantities
produced by its native direct-increment owner. For an accepted trial, let
`accepted_energy_delta_j` be the computed direct
increment $\widehat{\Delta E}$, let
`accepted_energy_roundoff_bound_j` be its nonnegative forward-error bound
$B_{\Delta E}$, and define

```{math}
:label: fem-relaxation-energy-upper-bound
\Delta E_{\mathrm{upper}}
=\widehat{\Delta E}+B_{\Delta E}.
```

The artifact field `accepted_energy_delta_upper_j` records this upper endpoint,
and `armijo_increment_rhs_j` records the accepted representable-chord Armijo
threshold $c_1\Delta E_{\mathrm{lin,fp}}$. All four fields have SI unit `J`. An ordinary accepted
step proves

```{math}
:label: fem-relaxation-armijo-proof
\Delta E_{\mathrm{upper}}
\le c_1\Delta E_{\mathrm{lin,fp}}<0.
```

These are acceptance-decision observables, not reconstructed diagnostics.
They are read after an accepted step through the caller-sized, versioned
`fullmag_fem_backend_take_accepted_energy_proof_v1` query; a successful take
clears the native record so it cannot be observed by a second take, an LLG
step, or a later snapshot. The unversioned
`fullmag_fem_step_stats` layout is unchanged. The runner copies the queried
values into the accepted `solver_steps.csv` row. Rejected trials never produce solver-step
rows and their candidate proof quantities must not leak into a later accepted
row. LLG and TPI export
`accepted_energy_proof_available=false`; their four optional artifact columns
are empty, never synthetic zero. The runner and artifact writer preserve the native values but do not
recompute the inequality.

This proof is deliberately distinct from subtracting published endpoint
`E_total` values. The latter are independently accumulated observables and may
show an absolute drift dominated by cancellation at the scale of the full
energy. Such drift neither replaces nor invalidates a direct Armijo proof; it
remains a recomputation-consistency diagnostic (record count and maximum
positive drift) and must not be silently relabelled as the accepted direct
increment or used as a Task 8 acceptance gate. Task 8 instead validates every
accepted PG-BB solver-step proof row and requires the valid proof-row count to
equal the executed-step count. Conversely, the four proof fields establish only
the native line-search decision for that accepted step. They do not by
themselves qualify long-horizon convergence, torque reduction, or agreement of
recomputed total-energy trajectories.

NCG acceptance is covered by the same per-step proof contract. Its CPU initial,
preconditioned-restart, and raw-gradient-restart routes call the shared CPU
direct-increment and refinement owner. Its CUDA initial and forced-restart
routes call the shared device direct-increment batch after precomputing the
representable chord against the accepted-state `H_eff`. Every accepted route
validates and publishes the exact proof before committing solver metadata.
Endpoint-total subtraction and a monotone-total fallback are not legal NCG
acceptance criteria. Exhaustion, a non-finite chord, an unchanged trial, or an
unresolved direct-increment interval restores magnetization, cached fields,
direction history, and accepted-proof state and fails closed.

This 2026-07-27 amendment is confined to the FEM direct-minimizer line-search
subsystem. It changes no energy equation, SI unit, public Python control,
ProblemIR field, planner capability, execution selection, OpenAPI resource,
workspace surface, tolerance, or provenance vocabulary. Validation requires
CPU/CUDA source and derivative contracts, consumable accepted-proof telemetry,
the three previously failing NCG interaction groups, and the existing broader
physics/parity gates. A passing focused group is not by itself production
qualification.

#### 3.2.3 Representability-stationary termination

A trial whose retraction returns the unchanged magnetic state is never an
accepted relaxation step. CPU and GPU may report
`representability_stationary` termination only after the line search proves
that every active retracted magnetic DOF is bitwise unchanged from the current
accepted state and that no representable trial exists under the permitted step
sequence. A norm estimate, small total-energy subtraction, one unchanged node,
or one underflowed trial is insufficient. Nonmagnetic/masked DOFs do not enter
this all-active-DOF proof.

This termination commits no new state, creates no accepted `solver_steps.csv`
row, and cannot satisfy torque convergence by implication. Completion and
convergence remain governed by the canonical equilibrium contract and the
accepted-state torque/plateau evidence. CPU/MFEM and CUDA must use the same
bitwise active-DOF condition; a device lane may reduce the all-unchanged flag
without copying trial vectors to the host. CUDA PG-BB owns a persistent
accepted-state `H_eff` device vector in its relaxation workspace. That vector
is allocated and byte-accounted with backend state, copied device-to-device
once before the line search, and reused for every representable-chord reduction;
trial field evaluation cannot replace the Armijo derivative owner on later
backtracks. No line-search allocation, vector readback, synchronization, or
extra demag solve is introduced. Focused CPU and real-CUDA contracts cover all
permitted unchanged trials, masked differences, one active-DOF negative
control, and reuse of accepted `H_eff` after a rejected trial overwrites the
live field.

#### 3.2.4 Cancellation-resistant uniaxial increment

For uniaxial anisotropy with unit axis $a_i$, nodal coefficient-volume
weights $K_{u1,i}V_i$ and $K_{u2,i}V_i$ in joules, and
$s_{k,i}=m_{k,i}\cdot a_i$, the direct accepted trial increment must use the
factored identity

```{math}
:label: fem-relaxation-uniaxial-increment
\Delta E_{\mathrm{ani}}
=-\sum_i V_i(s_{1,i}-s_{0,i})(s_{1,i}+s_{0,i})
  \left[K_{u1,i}+K_{u2,i}(s_{1,i}^2+s_{0,i}^2)\right],
```

which is algebraically identical to subtracting the canonical endpoint energy
$V_i[K_{u1,i}(1-s_{k,i}^2)+K_{u2,i}(1-s_{k,i}^4)]$ but does not first form
two nearly equal powers. Equivalently, the quadratic owner uses
$(s_1-s_0)(s_1+s_0)$, and the quartic owner multiplies that factor by
$(s_1^2+s_0^2)$. The sign, joule unit, per-node material semantics, magnetic
masking, and CPU/GPU reduction domain remain unchanged. The forward-error
owner must also accumulate an absolute component scale from the two factored
products; it must not use the already-cancelled increment as its roundoff
scale.

This identity changes only the numerical evaluation of the existing uniaxial
energy increment. It does not change `H_ani`, the public anisotropy energy,
ProblemIR, planner legality, or endpoint scalar artifacts. The native CPU and
CUDA direct-increment owners implement the same factored quadratic/quartic
contract, with a shared cancellation-focused test covering finite increments,
the descent sign, first-order directional agreement, and strict Armijo
acceptance at the observed near-aligned failure scale.

For Poisson demag, with endpoint fields from deterministic fresh solves, the
direct increment uses the polarized quadratic identity

```{math}
:label: fem-relaxation-demag-increment
\Delta E_d=-\frac{\mu_0}{2}\sum_i M_{s,i}V_i
  (m_{1,i}-m_{0,i})\mathbin{\cdot}(H_{d,0,i}+H_{d,1,i}),
```

For an airbox Robin realization, the same identity remains complete: each
endpoint field is recovered from $(K+\beta M_\Gamma)u=b(M)$, so the Robin
condition is already part of $H_d$. Adding
$\mu_0\beta u^TM_\Gamma u/2$ separately double-counts the boundary form
and breaks the variational identity $\delta E/\delta m=-\mu_0M_sH_d$.
Local and exchange terms are reduced as local energy-density differences. If
the direct floating-point interval overlaps
the Armijo threshold, the native lane repeats current and trial demag snapshots
from fresh initial states at an internal stricter tolerance. A trial is
accepted only when both ordinary and refined direct increments satisfy the
unchanged strict inequality; unresolved ambiguity fails closed and restores
the accepted state. No user-visible noise tolerance, algorithm substitution,
or device fallback is permitted.

For an accepted CUDA NCG endpoint $m_{k+1}$, the already evaluated tuple
$(m_{k+1}, H_d(m_{k+1}), H_\mathrm{eff}(m_{k+1}), E(m_{k+1}))$ may seed
exactly one next-step current evaluation. Reuse is legal only when the state,
drive, material, enabled-interaction, linear-solver policy, tolerance,
direct-increment refinement, device-residency, and workspace signatures all
match. The accepted endpoint token is consumed at most once. Any mismatch,
rollback, external state upload, or distinct trial endpoint invalidates the
token and requires a fresh zero-initial demag solve. This changes neither the
energy in joules nor the FEM mass metric; it removes a duplicate evaluation of
the same physical endpoint.

CPU/MFEM relaxation qualification artifacts carry an `algorithm_policy` block
with the resolved native realization, FEM mass metric, line-search policy, and
preconditioner/linear-solver contract. They intentionally do not report an
actual per-step Hypre-vs-serial preconditioner selection until the native ABI
exports that runtime measurement.

### 4.1 Energy derivative metric for direct minimizers

The field tangent gradient is intentionally retained as

```{math}
:label: fem-relaxation-tangent-gradient
g_i=-P_{m_i}H_{\mathrm{eff},i}.
```

with units `A/m`. Its lumped-volume norm is a solver and stop-control
quantity; it is not an energy derivative and therefore remains independent of
the Armijo product. Production PG-BB/NCG directions `p` also have units
`A/m`, and the trial state is `R(m + lambda p)` with `lambda` in `m/A`.
For nodal lumped volumes `V_i`, the exact-arithmetic physical line-search slope is

```{math}
:label: fem-relaxation-line-search-slope
\frac{dE(R_m(\lambda p))}{d\lambda}\bigg|_{\lambda=0}
=-\mu_0\sum_i M_{s,i}V_i H_{\mathrm{eff},i}\mathbin{\cdot}p_i
=\mu_0\sum_i M_{s,i}V_i g_i\mathbin{\cdot}p_i,
```

with units `J A/m`. Its classical Armijo decrement
`lambda * phi'(0)` is in joules. Production binary64 PG-BB evaluates the
equivalent first-order model on the representable retraction chord instead:

```{math}
:label: fem-relaxation-representable-linear-model
\Delta E_{\mathrm{lin,fp}}
=-\mu_0\sum_i M_{s,i}V_iH_{\mathrm{eff},i}(m)\mathbin{\cdot}
\left[R_m(\lambda p)_{\mathrm{fp},i}-m_i\right].
```

This is the value multiplied by `c1` and published as
`armijo_increment_rhs_j`. It is required to be strictly negative. At ordinary
scales it agrees with `lambda * phi'(0)` to first order; at a representability
boundary it truthfully excludes analytic motion that did not occur in the
stored trial.
For the derivative-matrix oracle, the perturbation direction `q` and sweep
parameter `epsilon` are dimensionless; the corresponding
`mu0 * sum(Ms_i V_i g_i . q_i)` is therefore directly in joules and is
compared with a retracted central difference in joules.

CPU/MFEM PG-BB, NCG, and TPI, plus CUDA PG-BB/NCG, use this nodal
`mu0 * Ms_i * V_i` weighted product for descent checks and the Armijo
right-hand side. `Ms_i` is
the per-node field when supplied, otherwise the material fallback; nonmagnetic
nodes contribute zero.  The same geometry is used for BB/PR+ curvature where
an energy-weighted product is required. For PR+, numerator and denominator
both have units `J A/m`, so `beta` is dimensionless. It must not replace the
RMS/max field-or-torque stopping metrics, whose `A/m` semantics are deliberately
mesh-extent independent.

CPU PR+ uses the preconditioned signed denominator
`d=sum_i mu0 Ms_i V_i g_i.z_i`. Its forward-error scale is the independently
accumulated `S_d=sum_i mu0 Ms_i V_i |g_i.z_i|`, never the PR numerator.
Positive curvature is resolved only when `d > gamma_N S_d`. CUDA NCG is
unpreconditioned, so its denominator is the nonnegative square sum
`sum_i mu0 Ms_i V_i |g_i|^2`; its absolute-term sum is the denominator itself
and the derived roundoff check reduces to exact positivity for finite
`gamma_N < 1`. The PR numerator is not used as a denominator-roundoff proxy.

The lumped-volume tangent-gradient norm has units `A^2 m` and is likewise a
nonnegative sum. Consequently `norm > gamma_N norm` reduces to exact
positivity: zero is the only dimensionally justified degenerate norm, while a
negative or non-finite result is an error. No joule label or joule-valued
absolute floor is used for that stop diagnostic.

### 4.2 Directional-derivative oracle tolerance

The native interaction matrix uses a retracted central difference
`D_h=(E(+h)-E(-h))/(2h)`. Its acceptance bound contains no fixed joule
constant. At each sweep point it is derived from:

- double-precision subtraction roundoff,
  `8 epsilon_64 max(|E(+h)|,|E(-h)|)/h`;
- the central-difference/retraction truncation estimate from the sweep,
  `|D_h-D_2h|/3`;
- analytic weighted-sum roundoff. The independent analytic oracle accumulates
  each scalar product before any vector-component cancellation,
  `S_D=sum_i sum_c |mu0 Ms_i V_i H_(i,c) q_(i,c)|`, and uses `gamma_N S_D`, not
  `gamma_N |D_analytic|`, because cancellation can make the latter arbitrarily
  smaller than the forward error. The qualification output retains the field
  name `absolute_term_sum_j` and reports
  `absolute_term_granularity=scalar_component` to make this reduction
  convention explicit.

At least one sweep point must satisfy `|D_h-D_analytic|` against the sum of
those three bounds. Independently, successive Richardson estimates must
contract by at least a factor of two after accounting for their energy
subtraction roundoff. This is weaker than the ideal factor of four for a
second-order central difference, but still proves convergence rather than
merely checking finiteness. The sweep
`h={2e-3,...,6.25e-5}` brackets the observed second-order region for the
four-node P1 qualification tetrahedron without tuning an interaction-specific
absolute tolerance. Demag additionally requires the reported linear-solve
relative residual to satisfy its configured `1e-10` limit. That dimensionless
solver gate remains separate because a residual cannot be converted to joules
without an operator-condition bound.

The CPU and CUDA NCG initial-step heuristic deliberately retains the existing
lumped-volume scaling convention; it is not presented as an energy derivative
and both lanes use the same convention. The trajectory and iteration count are
not public compatibility contracts.

Qualification artifacts for a runtime-resolved energy-weighted Armijo
algorithm record `metric = "mu0_ms_fem_lumped_volume"`,
`gradient_metric = "mu0_ms_fem_lumped_volume"`, `gradient_units = "A/m"`,
`search_direction_units = "A/m"`, `line_search_step_units = "m/A"`,
`armijo_slope_units = "J A/m"`, and `armijo_decrement_units = "J"`.
This applies to CPU TPI as well as PGBB/NCG because TPI's line search uses the
same energy-weighted slope and retraction units.

The audit compatibility field `armijo_derivative_units = "J"` names the
dimensionless-direction derivative oracle
`dE(R(m + epsilon q))/d epsilon`, not the production derivative with respect
to `lambda`. It is retained for migration from the audit schema while the
additional `armijo_slope_units = "J A/m"`,
`line_search_step_units = "m/A"`, and `armijo_decrement_units = "J"` fields
state the rigorous production convention. Thus `gradient_metric` is a stable
schema alias of `metric`, not a second numerical product. Requested but
unrealized algorithms, and payloads whose realization is absent or differs
from the exact `native_mfem_backend_relax_step` identifier, do not receive any
of those resolved-runtime claims.
Old payloads that omit the new optional fields remain readable; consumers must
not infer the new convention from omission and should rerun the workload when
resolved provenance is required.

Public final-state and total-energy meanings remain unchanged. This is valid for nodal material fields. Discontinuous
element `Ms` requires the separate material-interface qualification work.

(fem-relaxation-problem-ir)=
### 4.2 ProblemIR representation

Use a shared `StudyIR::Relaxation` shape across backends.
Backend-specific items such as:

- mass-lumped vs consistent,
- preconditioner family,
- tangent-plane linear solver options,

belong in `ExecutionPlanIR`.

### 4.3 Planner and capability-matrix impact

Planner must:

- reject unsupported relaxation algorithms on unsupported FE realizations,
- estimate whether a method requires:
  - only field evaluations,
  - line searches,
  - or linear solves,
- record stop reason and convergence metrics in provenance.

Capability matrix should separate explicit relaxation support from tangent-plane implicit support.

(fem-relaxation-round-trip-and-failure-semantics)=
### 4.4 Round-trip and failure semantics

Requested intent contains the authored relaxation algorithm and stopping
controls. Resolved execution records the actual FEM CPU/GPU realization and
must not be inferred from that request. Validation errors and unsupported combinations
fail before execution; strict GPU cannot silently resolve to a
CPU or diagonal-preconditioner fallback.

(fem-relaxation-validation)=
## 5. Validation strategy

### 5.1 Analytical checks

- energy descent on smooth convex-like test cases,
- torque-to-zero convergence on uniform-field equilibria,
- norm-defect control.

### 5.2 Cross-backend checks

- same initial condition on box geometry,
- compare final energies and average magnetization,
- compare final domain-wall / skyrmion chirality once DMI is available.

### 5.3 Regression tests

- projected-gradient FE relaxation benchmark,
- NCG restart/preconditioner benchmark,
- tangent-plane linear solve convergence benchmark,
- CPU fallback vs GPU partial-assembly parity.

(fem-relaxation-implementation-mapping)=
### 5.4 GPU/libCEED implementation entry point

GPU/libCEED relaxation production units belong under
`backends/fem/gpu/cuda/relaxation/`, not in a Rust-side solver. The executable
device-resident direct-minimizer slice currently covers projected-gradient BB
and nonlinear CG:

- reuse the existing GPU effective-field pipeline for exchange, local fields,
  DMI, demag, and energy reductions,
- use the native CUDA tangent-gradient, FEM metric-reduction, and normalized
  retraction kernels from `pgbb_kernels.cu`,
- keep Armijo/BB step control inside `pgbb.cpp` without host field copies in
  the hot loop beyond scalar energy/curvature decisions,
- publish through the existing `fullmag_fem_backend_relax_step` ABI only after
  CUDA parity and transfer-audit gates prove that the accepted-step loop has no
  hidden device-host synchronization beyond scalar convergence decisions.

The tangent-plane implicit GPU/libCEED solve is under development and remains
outside the active GPU solver set. Strict mode rejects TPI. Extended automatic
selection may resolve the requested GPU/auto intent to the CPU/MFEM development
lane with explicit provenance; forced GPU rejects with a clear diagnostic.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend (`llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`)
- [x] FEM backend (`llg_overdamped` on native CPU/MFEM and supported native GPU time-integration lanes)
- [x] FEM backend (`projected_gradient_bb` and `nonlinear_cg` native mass-weighted minimizers, including demag at `rtol<=1e-12`)
- [x] FEM backend (`projected_gradient_bb` and `nonlinear_cg` exchange-plus-mass preconditioned minimizers with serial MFEM CG as the current default and explicit Hypre/AMG opt-in for qualification)
- [ ] FEM PG-BB with demag source-bound managed qualification and direct polarized Armijo CPU/GPU evidence
- [x] FEM NCG initial/restart routes share the term-complete direct-increment and representable-chord Armijo proof contract on CPU/GPU
- [x] FEM backend (`tangent_plane_implicit` native CPU/MFEM tangent-plane solve with exchange, local anisotropy, Zeeman, DMI, and demag linear-response actions)
- [x] FEM GPU backend (`projected_gradient_bb` native CUDA tangent-gradient, mass-metric reduction, normalized-retraction kernels, Armijo/BB step source, native preflight/step boundary, and runner availability)
- [x] FEM GPU backend (`nonlinear_cg` native CUDA tangent-gradient, mass-metric dot products, normalized retraction, Armijo/PR+ step source, persistent direction state, native preflight/step boundary, and runner availability)
- [ ] FEM backend (`tangent_plane_implicit` full GPU/libCEED device-resident tangent-plane solve; under development)
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Targeted source-contract and managed runtime smoke coverage for current LLG/PG-BB/NCG executable lanes
- [x] Broader interaction-matrix CPU/GPU benchmark gate is wired for current LLG/PG-BB/NCG executable lanes
- [ ] Broader interaction-matrix CPU/GPU qualification pass with source-bound receipt
- [ ] Extended benchmark campaign across mesh refinements, adaptive timesteps, and publication-scale physics cases
- [x] Documentation (this note + `0500-fdm-relaxation-algorithms.md`)

(fem-relaxation-limitations)=
## 7. Known limits and deferred work

- no full Newton/Hessian methods,
- no NEB or saddle search,
- no thermal annealing,
- explicit relaxation can still be stiff on fine meshes,
- tangent-plane implicit design needs careful linear algebra ownership.

(fem-relaxation-scientific-bibliography)=
## 8. References

Scientific references:

- J. Barzilai and J. M. Borwein, "Two-Point Step Size Gradient Methods",
  *IMA Journal of Numerical Analysis* 8(1), 1988,
  [doi:10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141).
- J. Nocedal and S. J. Wright, *Numerical Optimization*, second edition,
  Springer, 2006,
  [doi:10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).

Internal references:

- `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- `docs/physics/0500-fdm-relaxation-algorithms.md`

(fem-relaxation-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Responsibility | Evidence status |
|---|---|---|---|---|
| Native relaxation boundary | `native/include/fullmag_fem.h` | `fullmag_fem_backend_relax_step` | exposes the FEM relaxation step ABI | current source |
| CPU tangent projector | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `project_node_tangent` | projects field-like nodal vectors with the representable-state denominator | current source |
| CPU tangent-gradient owner | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `tangent_gradient_from_field` | forms the field tangent gradient from the accepted effective field | current source |
| CPU normalization retraction | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `void retracted_step_into` | constructs representable retracted trial states | current source |
| CPU representable-chord model | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `representable_chord_energy_linear_increment` | evaluates the physical Armijo linear increment | current source |
| CPU energy-weighted product | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `energy_weighted_dot_fields` | evaluates the nodal $\mu_0M_sV$ product | current source |
| CPU transported BB secant | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `transported_bb_secant` | transports accepted-state chords and gradient differences | current source |
| CPU PG-BB step | `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp` | `run_projected_gradient_bb_step` | owns lumped-gradient trials, BB safeguards, and Armijo acceptance | current source |
| CPU tangent-plane step | `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp` | `run_tangent_plane_implicit_step` | owns the constrained implicit update and retraction | current source |
| CPU direct-increment aggregate | `backends/fem/cpu/mfem/relaxation/direct_energy_increment.cpp` | `direct_energy_difference` | assembles the term-complete direct increment and its bound | current source |
| CPU polarized exchange increment | `backends/fem/cpu/mfem/interactions/exchange_energy_difference.cpp` | `exchange_energy_difference` | evaluates the symmetric exchange-energy difference | current source |
| CPU uniaxial increment | `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp` | `uniaxial_anisotropy_energy_difference` | evaluates the cancellation-resistant anisotropy increment | current source |
| CPU polarized demag increment | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_difference_from_endpoint_fields` | evaluates the endpoint-field demag identity | current source |
| GPU PG-BB gradient boundary | `backends/fem/gpu/cuda/relaxation/pgbb.cpp` | `gpu_relax_compute_current_metrics` | owns the current PG-BB tangent-gradient path | current source; qualification separate |
| GPU NCG gradient boundary | `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` | `gpu_relax_compute_effective_field_energy_gradient_and_direction` | owns the current NCG tangent-gradient path | current source; qualification separate |
| GPU preconditioner resolver | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `resolve_gpu_relaxation_preconditioner` | keeps `none` as the current default | current source; full sparse `NOT VERIFIED` |
