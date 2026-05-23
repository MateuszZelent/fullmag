
# Higher-order and adaptive time integrators for FEM LLG on MFEM/libCEED/hypre with GPU

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`

## 1. Problem statement

This note defines how Fullmag should add **higher-order** and **adaptive-timestep**
time integrators to the FEM backend for LLG:

- SSPRK3 / RK3,
- RK4,
- embedded RK45 / Dormand–Prince 5(4),
- embedded RK56 / Verner 6(5)-class methods.

Unlike FDM, the FEM semi-discrete system has two extra concerns:

- the magnetization field lives in a finite-element space, not a flat grid array,
- field recovery may involve mass projection and demag solves at each stage.

Therefore this note is deliberately honest:
explicit high-order RK methods are useful and worth implementing,
but they are **not** the final answer for stiff FEM micromagnetics.

## 2. Physical model

### 2.1 Governing equation and semi-discrete form

The continuum LLG equation is

\[
\partial_t m
=
-\frac{\gamma}{1+\alpha^2}
\left[
m\times H_{\mathrm{eff}}
+
\alpha\, m\times (m\times H_{\mathrm{eff}})
\right].
\]

After FEM discretization in a vector space `V_h`, write

\[
m_h(\mathbf{x},t)=\sum_a m_a(t)\phi_a(\mathbf{x}),
\]

and obtain a semi-discrete system

\[
M \dot u = F(u,t),
\]

where

- `u` is the vector of magnetization DOFs,
- `M` is the vector mass operator (possibly weighted/lumped),
- `F(u,t)` is the assembled residual coming from the LLG RHS.

If the mass is lumped or cheaply invertible, explicit RK is natural.
If exact mass inversion is used every stage, explicit methods become much more expensive.

### 2.2 Tangency and norm control

The exact LLG flow is tangent to the sphere, but nodal FE DOFs and explicit RK stages are not.
For the first explicit high-order FEM rollout, use:

- stage-wise optional renormalization when stage norm defects get too large,
- accepted-step nodal renormalization,
- explicit diagnostics for `mean |m|` and `max ||m|-1|`.

This is less geometric than tangent-plane schemes but substantially easier to integrate into the existing FEM stack.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `u` | vector of FE magnetization DOFs | 1 |
| `M` | vector mass operator | — |
| `F(u,t)` | semi-discrete RHS | 1/s |
| `dt` | timestep | s |
| `atol, rtol` | adaptive tolerances | 1 |

### 2.4 Assumptions and approximations

This note covers explicit RK families only.
Deferred:

- tangent-plane time integrators,
- linearly implicit schemes,
- Rosenbrock / IMEX families,
- geometric midpoint / Cayley schemes.

## 3. Numerical interpretation

### 3.1 FDM

See:

- `0480-fdm-higher-order-and-adaptive-time-integrators.md`

### 3.2 FEM

#### 3.2.1 Recommended bootstrap semi-discrete form

For explicit RK in FEM, the preferred bootstrap form is

\[
\dot u = M_L^{-1} F(u,t),
\]

with `M_L` a lumped mass operator.

Why:

- no global solve per RK stage,
- fully local inversion on GPU,
- strong alignment with matrix-free libCEED operator application.

Consistent mass can remain available for diagnostics or later implicit schemes,
but it should not be the first production path for explicit adaptive integrators.

#### 3.2.2 Unified RK stage model

For any explicit `s`-stage method,

\[
U^{(j)} = u_n + dt \sum_{\ell<j} a_{j\ell} K^{(\ell)},
\qquad
K^{(j)} = M_L^{-1}F(U^{(j)}, t_n + c_j dt).
\]

Accepted-step and embedded-step formulas are the same as in FDM.

The only additional FEM cost is that each stage requires:

1. local operators (exchange, DMI, Zeeman),
2. demag solve or demag operator application,
3. mass-lumped inverse application,
4. possible output-space projections.

#### 3.2.3 Final-field freshness and reported stage cost

Native FEM production telemetry must report the actual effective-field work
performed by the backend. `H_eff` is the source for the LLG RHS, torque
observable, stop criteria, and live field readback. In the default scientific
mode, the accepted step must therefore leave `H_eff` fresh for the final
magnetization state.

That rule has a direct performance consequence:

- non-FSAL methods such as Heun and RK4 need a post-step final `H_eff` refresh
  after the accepted state is formed;
- FSAL methods such as Bogacki-Shampine RK23 and Dormand-Prince RK45 may reuse
  the final stage only when that stage is evaluated at the accepted final state;
- `rhs_evals` must include the post-step RHS/effective-field refresh when it is
  executed;
- `demag_solve_count` must include every Poisson demag solve, including the
  final refresh.

For one fixed, accepted step without rejection in exact-telemetry mode, the
expected first-step costs are:

| Integrator | Stages | FSAL | Expected reported RHS evaluations | Final refresh |
|---|---:|---|---:|---|
| Heun | 2 | no | 3 | explicit post-step refresh |
| RK4 | 4 | no | 5 | explicit post-step refresh |
| RK23 / Bogacki-Shampine 3(2) | 4 | yes | 4 on first step, then 3 when FSAL is reused | cached final stage |
| RK45 / Dormand-Prince 5(4) | 7 | yes | 7 on first step, then 6 when FSAL is reused | cached final stage |

Any future performance mode that skips the final refresh must be explicit in
runtime metadata and must not present stale torque or energy as exact final-step
observables.

#### 3.2.4 CPU reference history/cache allocation contract

The Rust FEM CPU reference path is allowed to use host-owned scratch storage,
but repeated accepted steps should not allocate new RHS history vectors when the
caller uses `FemLlgProblem::step_with_workspace`.

For ABM3, the first startup steps initialize the three RHS history slots
`f_n`, `f_{n-1}`, and `f_{n-2}`. After all three slots exist, accepted ABM3
steps must rotate and overwrite those slots instead of allocating a fresh
history vector. This preserves the Adams-Bashforth-Moulton formula and only
changes buffer lifetime.

For RK45, the FSAL cache is a reusable RHS slot for the final stage of an
accepted Dormand-Prince step. Reusing its allocation is valid only when the
cached stage corresponds to the accepted final state and is consumed as the
next step's first RHS sample.

#### 3.2.5 Recommended rollout order

##### A. SSPRK3 / RK3

Good bootstrap method for:

- low-order FE spaces,
- exchange-only or weakly nonlocal test problems,
- parity checks against FDM.

Adaptive version:
step doubling only.

##### B. RK4

Useful as a trusted reference and convergence tool.
Adaptive version:
step doubling.

##### C. Dormand–Prince 5(4)

Recommended first production adaptive explicit method.

Why:

- good accuracy/cost tradeoff,
- standard adaptive controller,
- widely understood behavior,
- can reuse FDM-side planner and diagnostics semantics.

##### D. RK56 / Verner 6(5)

Useful for high-accuracy research runs and smooth dynamics traces.
Not the default because the extra stages multiply demag and operator-application cost.

#### 3.2.5 Adaptive controller

Use the same normalized embedded-error formula as FDM, but define the FE vector norm locally per node or DOF block.

For nodewise control:

\[
\eta_a
=
\frac{\|e_a\|_2}{\mathrm{atol} + \mathrm{rtol}\,\max(\|u^{hi}_a\|_2,1)},
\qquad
\eta = \max_a \eta_a.
\]

Accept if `\eta \le 1` and norm-defect diagnostics are below threshold.

Recommended controller:

\[
dt_{\mathrm{new}} = \mathrm{safety}\,dt\,\eta^{-1/q},
\]

with the same estimator-order logic as in the FDM note.

#### 3.2.6 GPU architecture with MFEM + libCEED + hypre

Explicit RK stage execution should be organized as:

1. evaluate local nonlinear operators through libCEED QFunctions,
2. apply demag operator:
   - bootstrap: air-box solve or equivalent FEM demag realization,
   - later: improved open-boundary realization,
3. apply lumped inverse mass,
4. assemble RK stage update,
5. reduce max error / norm diagnostics on device.

Key architectural point:
the FEM explicit integrator should depend only on a backend callback of the form

\[
u \mapsto M_L^{-1}F(u,t),
\]

not on the details of exchange, DMI, or demag.
That keeps the stepper reusable.

#### 3.2.7 Honesty about stiffness

Exchange on fine unstructured meshes can produce severe stability limits for explicit methods:

\[
dt_{\max} \sim C h^2 / A
\]

up to problem-dependent constants.

Therefore:

- explicit RK should be public and supported,
- but the planner should warn when the mesh and material scales suggest a strongly stiff regime,
- and later implicit/tangent-plane families should remain on the roadmap.

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Recommended shared API extension:

```python
fm.LLG(
    integrator="dopri54",
    adaptive=fm.AdaptiveTimestep(
        atol=1e-5,
        rtol=1e-4,
        dt_initial=1e-15,
        dt_min=1e-18,
        dt_max=1e-11,
        safety=0.9,
        growth_limit=5.0,
        shrink_limit=0.2,
        norm_tol=1e-6,
    ),
)
```

The public API should be backend-neutral.
Do not expose FE mass-lumping or CEED knobs in the user-facing integrator object.

Status: the convenience Python DSL now propagates `dt_min` through flat/study
`solver(...)`, direct `relax(...)`, `run_while(..., relax=True)`, and staged
`study.stages.add_relax(...)` calls into `AdaptiveTimeStepIR`. This keeps the
minimum-step floor expressible without exposing backend-specific adaptive-RK
implementation details.

### 4.2 ProblemIR representation

The same `IntegratorChoice` and `AdaptiveTimeStepIR` used by FDM should be shared.
Backend-specific FE realization choices belong in `ExecutionPlanIR`, not in public model objects.

### 4.3 Planner and capability-matrix impact

Planner must:

- reject adaptive integrators on unsupported FEM realizations,
- record whether lumped mass is used,
- record demag realization because it affects stage cost strongly,
- emit warnings for very stiff mesh/material combinations.

Capability matrix should distinguish:

- semantic support,
- internal reference explicit support,
- public-executable explicit support,
- future implicit/tangent-plane support.

## 5. Validation strategy

### 5.1 Analytical checks

- convergence order on smooth exchange-only FE problems,
- norm-drift diagnostics,
- timestep-halving studies.

### 5.2 Cross-backend checks

- compare FDM vs FEM on the same box problem,
- compare accepted `dt(t)` trends,
- compare `E(t)` and final magnetization observables.

### 5.3 Regression tests

- SSPRK3 / RK4 / DOPRI parity on smooth FE examples,
- lumped-mass vs reference consistent-mass smooth-case parity,
- CPU fallback vs GPU partial-assembly parity,
- adaptive-step accept/reject determinism in fixed precision.
- native FEM telemetry for Heun, RK4, RK23, and RK45 must assert the expected
  `rhs_evals`, `demag_solve_count`, and FSAL reuse contract described in
  section 3.2.3.
- benchmark harnesses must sweep an explicit integrator axis instead of
  benchmarking a hard-coded Heun run.

## 6. Completeness checklist

- [x] Python API surface for backend-neutral adaptive `dt_min` propagation
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [ ] Documentation

## 7. Known limits and deferred work

- no tangent-plane / geometric integrators in this note,
- no implicit or IMEX methods,
- explicit RK on fine FE meshes may be very stiff,
- demag stage cost can dominate high-order methods.

## 8. References

Internal references:

- `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
- `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`
