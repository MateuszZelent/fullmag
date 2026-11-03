# Canonical LLG time-domain solver and qualification contract

- Status: approved for implementation
- Owners: Fullmag core
- Last updated: 2026-07-31
- Related audit:
  - `docs/audits/2026-07-16-llg-time-domain-solver-audit.md`
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`
  - `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
  - `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`

(problem-statement)=

## 1. Problem statement

This note defines the canonical physical, numerical, public-API, provenance,
and qualification contract for advancing the full Landau-Lifshitz-Gilbert
(LLG) equation in physical time after initialization or relaxation. It closes
the ambiguity between a fixed timestep and the initial seed of an adaptive
solver, removes hidden timestep sentinels, defines a MuMax-style maximum-error
convenience policy, and specifies the fail-closed behavior required of every
FDM and FEM realization.

The immediate motivating failure is an autonomous high-damping run whose
energy grows after relaxation. In the absence of explicitly time-dependent
drives, spin-transfer torque, thermal noise, or another nonconservative term,
that behavior is not physically admissible beyond a bounded numerical error.
The solver must reject or fail a step that cannot satisfy its error, geometry,
field-solve, and stability contracts; it must never publish a known-invalid
state.

This note covers:

- fixed-step explicit LLG;
- adaptive embedded explicit LLG;
- exact requested/resolved timestep semantics;
- controller, guard, transaction, demagnetization, and telemetry contracts;
- scientific qualification for FDM CPU/CUDA and FEM CPU/GPU;
- the separate future stiff tangent-plane time-integration lane.

Direct energy minimization and overdamped relaxation remain governed by
`0580-canonical-relaxation-equilibrium-contract.md`. They may provide the
initial state but are not substitutes for physical-time LLG integration.

Stable contract identifiers used by cross-document checks are:

- `LLG-TD-POLICY-V1`: fixed/adaptive public and resolved timestep policy;
- `LLG-TD-ATTEMPT-V1`: fail-closed attempted-step transaction and telemetry;
- `LLG-TD-STIFF-V1`: separately selected stiff physical-time integrator lane.
- `LLG-TD-FIRST-DT-V1`: omitted `dt_initial` resolves to exactly `dt_min`;
- `LLG-TD-MAX-ERR-V1`: `max_err` is an absolute maximum vector error;
- `LLG-TD-ATOMIC-V1`: every attempted step commits all state exactly once or
  restores the complete pre-attempt state.

## 2. Physical model

(governing-equations)=

### 2.1 Governing equation

For reduced magnetization `m = M/Ms`, with `|m| = 1`, Fullmag advances

```{math}
:label: eq-canonical-llg-rhs
\frac{\partial m}{\partial t}
=-\frac{\gamma_0}{1+\alpha^2}
\left[m\times H_\mathrm{eff}
+\alpha m\times(m\times H_\mathrm{eff})\right]
+\tau_\mathrm{nc},
```

where `gamma_0 = mu_0 |gamma|` under the canonical Fullmag convention and
`tau_nc` collects explicitly enabled nonconservative torques.

The effective field is the variational derivative of the modeled energy,

```{math}
:label: eq-effective-field-variational
H_\mathrm{eff}=-\frac{1}{\mu_0 M_s}\frac{\delta E}{\delta m},
```

with the exact interaction set recorded in the problem and runtime
provenance.

(planned-dissipation-invariant)=

### 2.2 Autonomous dissipation invariant

For time-independent energy, `alpha > 0`, and `tau_nc = 0`,

```{math}
:label: eq-autonomous-energy-dissipation
\frac{dE}{dt}
=-\frac{\alpha\gamma_0\mu_0 M_s}{1+\alpha^2}
\int |m\times H_\mathrm{eff}|^2\,dV \le 0.
```

Discrete trajectories may exceed strict monotonicity by only the documented
integration, field-solve, and energy-evaluation budget. A persistent or
convergence-order-inconsistent energy increase is a solver failure, not a
physical consequence of large damping. Increasing `alpha` does not remove
the explicit stability restriction; the dissipative rate is proportional to
`alpha/(1+alpha^2)`.

(symbols-and-si-units)=

### 2.3 Symbols and SI units

| Symbol / field | Meaning | SI unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `H_eff` | effective field | A/m |
| `Ms` | saturation magnetization | A/m |
| `alpha` | Gilbert damping | 1 |
| `gamma_0` | `mu_0 |gamma|` | m/(A s) |
| `t`, `dt`, `fix_dt`, `dt_initial`, `dt_min`, `dt_max` | physical time or timestep | s |
| `max_err` | maximum node/cell embedded vector error | 1 |
| `atol`, `rtol` | advanced absolute/relative error tolerances | 1 |
| `eta` | normalized error acceptance metric | 1 |
| `theta_max` | maximum spin rotation in an attempted step | rad |
| $\tau_\mathrm{nc}$ | explicitly enabled nonconservative contribution to $\partial m/\partial t$ | `1/s` |
| $\mu_0$ | vacuum permeability | `N A^-2` |
| $E$ | modeled magnetic energy | `J` |
| $\Omega_m$ | magnetic material domain of integration | `m^3` |
| $e_i$ | embedded vector error at active degree of freedom $i$ | 1 |
| $m_i^{lo}$ | low-order embedded magnetization state | 1 |
| $m_i^{hi}$ | high-order embedded magnetization state | 1 |
| $\eta_i$ | normalized embedded error at degree of freedom $i$ | 1 |
| $i$ | active node or cell index | 1 |
| $r$ | proposed timestep ratio | 1 |
| $s$ | dimensionless controller safety factor | 1 |
| $q$ | embedded estimator order | 1 |
| $\eta_n$ | current normalized error metric | 1 |
| $\eta_{n-1}$ | previous normalized error metric | 1 |
| $m_i^n$ | accepted magnetization at active degree of freedom $i$ | 1 |
| $dV$ | volume integration element | `m^3` |

(assumptions-and-validity)=

### 2.4 Assumptions and validity limits

- `m` is reduced magnetization and is finite at every active cell/node.
- Fixed and adaptive timestep policies are mutually exclusive.
- Explicit embedded RK methods are not unconditionally stable. Passing a
  local-error estimator alone is not proof of stability on a stiff mesh.
- Demagnetization and any other iterative field solve are part of the RHS
  contract. Their failure invalidates the attempted step.
- Output sampling times are distinct from internal solver steps.
- Stochastic thermal dynamics require separate statistical validation and do
  not obey pathwise energy monotonicity.

(discrete-realization)=

## 3. Numerical interpretation

### 3.1 Canonical fixed and adaptive policies

The fixed policy is

```python
# %%
study.solver(integrator="rk45", fix_dt=1e-15, g=2.115)
```

Despite the embedded tableau, `fix_dt` means exactly one fixed attempted
timestep policy: no error-based retry and no adaptive next-step suggestion.

The adaptive policy is

```python
study.solver(
    integrator="rk45",
    dt_initial=1e-15,  # optional
    dt_min=1e-16,
    dt_max=1e-14,
    max_err=1e-6,
    g=2.115,
)
```

If `dt_initial` is omitted, requested intent remains `null` in ProblemIR and
the resolved first attempted step is exactly `dt_min`. Equality
`dt_initial == dt_min` is an explicit value, never a sentinel. There is no
global `1e-13` or `1e-10` fallback. Bounds and defaults, if any, must be
defined once in the public model and preserved in provenance.

`fix_dt` cannot be combined with `dt_initial`, `dt_min`, `dt_max`, `max_err`,
or an advanced adaptive-timestep object. Adaptive bounds require

```{math}
:label: eq-adaptive-timestep-bounds
0 < dt_\min \le dt_\mathrm{initial} \le dt_\max
```

when the optional middle value is present.

### 3.2 `max_err` and advanced tolerance semantics

The public convenience parameter `max_err` follows the MuMax-style maximum
vector-error interpretation. For each active cell or FEM node/block,

```{math}
:label: eq-maximum-vector-error
\eta_i=\frac{\|m_i^{hi}-m_i^{lo}\|_2}{\mathrm{max\_err}},
\qquad \eta=\max_i\eta_i.
```

The embedded-error condition is `eta <= 1`. This is an absolute error on the
dimensionless reduced-magnetization vector. It is intentionally not diluted
by a hidden relative tolerance of order `1e-3` when a physically relevant
transverse perturbation is much smaller than `|m| = 1`.

The lower-level `AdaptiveTimestep(atol=..., rtol=...)` policy remains an
advanced alternative. It uses

```{math}
:label: eq-advanced-vector-error
\eta_i=\frac{\|e_i\|_2}
{atol+rtol\max(\|m_i^n\|_2,\|m_i^{hi}\|_2)}.
```

Exactly one tolerance policy is active. Canonical lowering of `max_err=x`
may resolve numerically to `atol=x, rtol=0`, but ProblemIR and provenance must
retain that the user requested maximum-error mode. At least one of `atol` and
`rtol` must be positive; both must be finite and nonnegative. Legacy
`max_error` is a deprecated alias of `max_err`, with identical semantics, and
must be rejected when mixed with `max_err` or advanced tolerances.

For each active node, the advanced relative-error scale is
`atol + rtol * max(||m_old||, ||m_hi||)`, where `m_old` is the accepted
pre-attempt state and `m_hi` is the unnormalized high-order candidate. Neither
post-normalization state alone nor an artificial unit floor may replace this
scale. Invalid sizes, nonfinite values, or a nonpositive resolved scale fail
the attempt closed.

### 3.3 Order-aware adaptive controller

One backend-neutral scalar decision contract governs all adaptive lanes. For
an embedded estimator of order `q`, the controller consumes the current and
previous finite error metrics, attempted `dt`, bounds, safety factor, and
growth/shrink limits. The proportional exponent depends on `q`; a PI history
term may be used, but its coefficients and startup rule must be documented
and tested with shared golden vectors.

The canonical controller uses the embedded estimator order `q = order_est`
from the selected tableau, with the defensive scalar-contract range
`1 <= q <= 16`; current RK23 and RK45 use `q=2` and `q=4`. On startup, after a reset, or after an exactly zero
accepted error, no PI history is active and

```{math}
:label: eq-adaptive-controller-startup
r=s\,\eta_n^{-1/(q+1)}.
```

For an accepted step with positive current error and positive accepted-step
history `eta_(n-1)`, the PI ratio is

```{math}
:label: eq-adaptive-controller-pi
r=s\,\eta_n^{-0.7/(q+1)}\eta_{n-1}^{0.4/(q+1)}.
```

Rejected steps use the startup proportional expression and never publish
their error as accepted history. The ratio is clamped to
`[shrink_limit, growth_limit]`, then the proposed timestep is clamped to
`[dt_min, dt_max]`. The decision reports the resulting bounded ratio
`dt_next/dt_attempt`. This rule intentionally permits an accepted step to
suggest a smaller next timestep.

Controller limits require finite `0 < safety <= 1`, `growth_limit > 1`, and
`0 < shrink_limit < 1`. Exactly `safety=1` is legal and is not a sentinel.
Acceptance and timestep bounds are inclusive: `eta=1` is accepted, and
attempts exactly at `dt_min` or `dt_max` are valid. The previous-error scalar
must always be finite, even while history is inactive; it must additionally be
positive when history is active. Finite zero is the canonical inactive-history
placeholder and is ignored by the startup expression.

A physical stage endpoint has one narrow exception to the attempted-step lower
bound. When the positive remaining physical interval is shorter than `dt_min`,
the runtime may make one terminal RK45 attempt using that exact remaining
interval to reach the requested endpoint. This endpoint-bounded interval is
not a controller proposal: the adaptive controller keeps the authored
`[dt_min, dt_max]` bounds for every subsequent proposal. The terminal attempt
must pass the same error, geometry, stability, and final-field checks as any
other attempt, and its magnetization and physical clock commit together. If the
error estimate exceeds tolerance, the runtime reports `dt_min_exhausted`; any
other failed guard keeps its typed failure. Every failed terminal attempt
restores the pre-attempt state and is never retried below the endpoint interval
or force-accepted. The runtime must not extend the physical stage beyond its
endpoint or change a checkpoint time without solving the corresponding
interval. This exception does not change ordinary attempt bounds or the
resolved first-step policy.

The bounded decision vocabulary is `accepted`, `retry`, and `failed`. The
bounded reason vocabulary is `within_tolerance`, `error_above_tolerance`,
`dt_min_exhausted`, `invalid_order`, `invalid_bounds`,
`invalid_controller_limits`, `invalid_timestep`, `invalid_current_error`, and
`invalid_previous_error`. Invalid input returns `failed` before controller
history or counters change. An error above one at `dt_min` returns
`failed/dt_min_exhausted`; it is neither accepted nor retried, but the failed
numerical attempt increments the rejection counter exactly once. CPU and GPU
restore candidate magnetization before returning this terminal failure.

FEM CPU and the transitional FEM CUDA host-control adapter consume the same
immutable scalar golden vectors. Their FP64 scalar parity budget is
`2e-15` for dimensionless ratios; FP32-rounded input parity uses `8e-6`.
This host scalar parity is not evidence of a device-resident adaptive control
loop or full FEM GPU scientific qualification.

The decision contract must permit an accepted step to suggest
`dt_next < dt_attempt`. It must not clamp every accepted ratio to one or
larger. A rejected attempt at `dt_min` returns typed `dt_min_exhausted`; it is
never force-accepted and never retried indefinitely. Invalid bounds, invalid
order, and nonfinite metrics fail before state mutation.

### 3.4 Geometry and stability guards

Acceptance requires all enabled guards to pass:

- finite candidate and embedded error;
- maximum pre-normalization norm defect;
- maximum spin rotation
  `acos(clamp(m_n dot m_candidate, -1, 1))`;
- embedded error;
- field-solve convergence;
- optional autonomous energy/stability diagnostic.

Normalization is not a repair for a zero, subnormal-norm, or nonfinite active
stage vector. Such a stage fails the attempt. Norm defect is measured before
normalization, and normalization of a valid candidate occurs only within the
candidate transaction.

Local error control cannot detect every explicit-stability violation. The
planner and runtime must therefore expose stiffness diagnostics, and the
scientific qualification must include a fast exchange-mode oracle and
`dt`, `dt/2`, `dt/4` convergence.

### 3.5 Atomic attempted-step transaction

An attempted step owns a private candidate state. Magnetization, physical
time, accepted-step index, effective fields, energy/torque observables,
demagnetization caches, FSAL history, adaptive history, device-residency
state, and trace counters become live together exactly once after every
acceptance condition and final refresh succeeds.

Any rejection or error restores the complete pre-attempt state. Failure after
candidate construction, during final field refresh, or during statistics
collection cannot leak a partial commit.

The native explicit FEM realization implements this boundary with a
solver-local transaction that spans backend dispatch through final statistics.
The CPU high-order magnetization is constructed in a private candidate buffer;
the live magnetization is exchanged only after the endpoint field refresh has
succeeded.  The transaction snapshots published interaction fields and
energies, demagnetization field/cache and potential warm-start state, FSAL
state, adaptive-controller state, stage-completion state, transfer/timing
counters, and accepted time/index.  The CUDA realization additionally keeps
persistent device-to-device rollback storage for magnetization, dynamic field
components, FSAL `k0`, and Poisson solution buffers, so rollback does not depend
on an unbounded device-to-host round trip.  Device residency metadata is
committed or restored with those buffers.  Deterministic internal failpoints at
post-candidate, endpoint-refresh, and final-statistics boundaries are reserved
for native atomicity contracts and are disabled by default.

### 3.6 Demagnetization convergence

Every iterative demagnetization realization must report solver kind,
iterations, finite residual, requested absolute/relative tolerance, maximum
iterations, and converged status. A false convergence flag, nonfinite
residual, or residual above the requested bound is a typed RHS failure. The
field is not marked current or cached and cannot enter LLG, energy, or output.

### 3.7 FDM interpretation

FDM CPU AoS/SoA and CUDA FP32/FP64 consume the same public policy and scalar
decision vectors. Fixed RK23/RK45 remain fixed. Adaptive batch execution must
use each accepted `dt_next`; it may not keep an immutable initial `dt`.
Unsupported multilayer adaptive execution fails before native
materialization. FP32 capability remains separate from FP64 qualification.

The Task 7 implementation establishes fixed-versus-adaptive separation for
the CPU reference AoS/SoA paths and source-visible CUDA FP64/FP32 paths. A
versioned `fullmag_fdm_backend_create_time_policy_v2` ABI carries tolerance
mode, `atol`, `rtol`, timestep bounds, safety and growth/shrink limits, plus
optional norm and rotation guard intent without reinterpreting the legacy ABI.
Guard-enabled execution fails closed until those guards are enforced.
Adaptive v2 execution is restricted to RK23/RK45, and maximum-error mode
requires `rtol=0`. Advanced mode accepts absolute-only, relative-only, or
combined control, provided at least one of `atol` and `rtol` is positive;
incompatible intent is rejected before stepping.
Rejected attempts above tolerance at `dt_min` report
`dt_min_exhausted`; CPU behavioral tests also prove pre-attempt state is not
committed. CUDA batch orchestration consumes the accepted `dt_suggested` on
the following attempt. The legacy create symbol retains its historical
embedded-adaptive proportional controller, including the absence of a ratio
clamp beyond the historical timestep bounds.

This is implementation and contract evidence, not scientific qualification.
The managed `verify-fdm-time-domain-native-contract` gate compiles the native
FDM library, including the RK23/RK45 CUDA FP64 and FP32 translation units, and
runs the v2 ABI/source contract. It does not execute trajectory parity on GPU
hardware, so no CUDA FP64 or FP32 runtime qualification claim follows.
The canonical scalar decision has one backend-neutral native owner used by
FEM and FDM. FDM CPU mirrors and tests the same immutable q=2/q=4 vectors,
accepted-error PI history, startup rule, accepted shrink, zero-error growth
limit, and terminal floor failure. Device guard enforcement and complete
attempt-trace evidence remain later work. Multilayer adaptive intent remains unsupported and
fails closed for both maximum-error and advanced modes before native
materialization.

### 3.8 FEM interpretation

FEM CPU/MFEM and FEM GPU/CUDA use separate performance realizations but the
same equations, tolerance modes, scalar decision semantics, attempt reasons,
and artifact schema. Error, norm, rotation, and nonfinite reductions are
node/block based; GPU reductions remain device-resident until bounded scalar
results are copied to the host. `order_est` comes from the selected RK
tableau. Error and guard reductions include active magnetic nodes only;
nonmagnetic shared-domain/airbox nodes cannot create a zero relative scale or
otherwise influence acceptance.

The legacy `fullmag_fem_adaptive_config` layout and
`fullmag_fem_backend_create` symbol remain unchanged. Guard-capable callers use
`fullmag_fem_adaptive_config_v2`, whose `abi_version` and `struct_size` precede
the complete legacy base plus optional norm/rotation guards, together with
`fullmag_fem_backend_create_v2`. A stale version or size fails before any v2
field is interpreted; the legacy entrypoint never reads the v2 tail.

(planned-tangent-plane-weak-form)=

### 3.9 Stiff tangent-plane time-integration lane

The existing `tangent_plane_implicit` relaxation algorithm is not a physical
time integrator: its step is an energy-search scale, it omits the full
precessional LLG operator, and it advances no physical clock. It must not be
advertised as a stiff time-domain solver.

The approved design selects the normalized first-order theta-tangent-plane
method with `theta = 1` as the intended first production scheme. Once
implemented, it will be selected explicitly as `integrator="tangent_plane"`
and use a fixed physical `fix_dt`. Adaptive control and switching from an
explicit method are not part of this lane.

Let `V_h` be the vector P1 magnetic finite-element space and

\[
K_h(m_h^n)=\{\phi_h\in V_h:\phi_h(z)\cdot m_h^n(z)=0
\text{ at every active magnetic node }z\}.
\]

The step first evaluates every non-exchange field and every direct torque at
the accepted state `(m_h^n,t_n)`. It then finds a tangent velocity
`v_h^n in K_h(m_h^n)`, with SI unit `1/s`, such that for every
`phi_h in K_h(m_h^n)`:

```{math}
:label: eq-tangent-plane-weak-form
\begin{aligned}
&\int_{\Omega_m}\mu_0 M_s
  \left[\alpha v_h^n+m_h^n\times v_h^n\right]\cdot\phi_h\,dV\\
&\quad+2\gamma_0\theta\Delta t
  \int_{\Omega_m} A\,\nabla v_h^n:\nabla\phi_h\,dV\\
&=-2\gamma_0\int_{\Omega_m}A\,\nabla m_h^n:\nabla\phi_h\,dV
 +\gamma_0\int_{\Omega_m}\mu_0 M_s
  H_{\mathrm{other}}(m_h^n,t_n)\cdot\phi_h\,dV\\
&\quad+\int_{\Omega_m}\mu_0 M_s
  \left[\alpha\tau_{\mathrm{nc}}^n
  +m_h^n\times\tau_{\mathrm{nc}}^n\right]\cdot\phi_h\,dV .
\end{aligned}
```

Here `H_other = H_eff - H_ex`; it includes enabled demagnetization, Zeeman,
anisotropy, DMI, Oersted, magnetoelastic, thermal, and regional-drive fields.
All of those terms are explicit in this first-order lane. A direct torque is
already expressed as a contribution to `dm/dt`, which is why its Gilbert-form
right-hand side is `alpha*tau_nc + m cross tau_nc`. No field or torque may be
counted in both terms. Elementwise `A`, nodal/elementwise `Ms`, and nodal
`alpha` use the same material quadrature policy as the production FEM field
operators. Nonmagnetic airbox degrees of freedom are excluded from `V_h` and
the tangent solve.

After the linear solve, active nodal values are retracted once:

```{math}
:label: eq-tangent-plane-retraction
m_h^{n+1}(z)=
\frac{m_h^n(z)+\Delta t\,v_h^n(z)}
{\left|m_h^n(z)+\Delta t\,v_h^n(z)\right|}.
```

The planned method is first-order in physical time. With `theta=1`, exchange
is implicit; qualification must establish whether the implemented lane avoids
an explicit `dt proportional to h^2` exchange-stability restriction. Explicit
local/nonlocal interactions can still impose accuracy or stability
restrictions, so the method is not intended to be an unconditionally stable
solver for every enabled model. Dense output is not part of this contract.
The planned runtime shortens a step to land exactly on an output event or
rejects an incompatible fixed clock; it does not interpolate this method as
if it were RK45.

The planned tangent system is nonsymmetric because of the gyrotropic
`m cross v` block. Its proposed CPU solver is MFEM/Hypre GMRES with an
exchange-plus-damping symmetric proxy preconditioner. Proposed defaults are
relative residual `1e-10`, absolute residual `0`, maximum `500` iterations,
and restart dimension `50`. A future implementation must check the achieved
finite true residual, iteration count, requested limits, and convergence flag
after every solve. Reaching the iteration limit, a nonfinite residual, or a
residual above the requested bound must fail the attempted step. These values
are intended as typed resolved configuration and provenance; changing them
would require a new qualification identity. A future public expert override
must be added as a typed object, not an unvalidated JSON escape hatch.

One attempted step is a transaction. The old magnetization, time, fields,
demagnetization cache and potential, direct-torque state, solver diagnostics,
and output counters remain live until the tangent solve, retraction, endpoint
field refresh, norm/finite checks, energy evaluation, and statistics all
succeed. Any failure restores all pre-attempt state. Autonomous energy is a
qualification diagnostic: exchange-only theta=1 must dissipate within the
linear-solve/roundoff budget, while explicit non-exchange terms are required
to converge under `dt`, `dt/2`, and `dt/4`; an energy increase is never hidden
by normalization.

The planned CPU implementation location is
`backends/fem/cpu/mfem/integrators/tangent_plane/`; planned backend-neutral
scheme configuration and diagnostics belong under `backends/fem/core/`. The
planned GPU implementation location is
`backends/fem/gpu/cuda/integrators/tangent_plane/`. These physical-time source
paths are not present in the current checkout and neither lane is implemented
or qualified. Any future GPU implementation must use device-resident state and
must not call the CPU implementation or fall back to it. The existing
`run_tangent_plane_implicit_step()` remains an energy minimizer and is not
physical-time evidence.

### 3.10 Hybrid interpretation

Hybrid execution is unsupported until it can preserve the complete timestep
policy, transaction, trace, and convergence contracts across the boundary.
It must fail closed rather than silently drop adaptive intent.

(implementation-mapping)=

## 4. API, IR, planner, runtime, and artifacts

(python-api)=

### 4.1 Python API surface

Both module-level `solver(...)` and `StudyBuilder.solver(...)` expose:

- `integrator`;
- `fix_dt`;
- `dt_initial`, `dt_min`, `dt_max`, `max_err`;
- `gamma` or `g` under the existing mutual-exclusion convention;
- advanced `adaptive_timestep` where already supported.

`integrator="tangent_plane"` accepts `fix_dt` and rejects every adaptive knob.
It is FEM-only. The intended first qualification target is strict FP64 CPU,
followed by a separately qualified strict FP64 GPU realization. FDM, FP32,
and hybrid execution, plus multilayer configurations that cannot assemble the
documented material weak form and unsupported direct-torque combinations, fail
during validation or planning before native materialization.

Canonical script export emits `fix_dt` for fixed mode and the four adaptive
names for maximum-error mode. It never reconstructs adaptive intent as a
fixed `dt`. Import/export and UI/scene round-trips preserve omitted
`dt_initial` losslessly.

(problem-ir)=

### 4.2 ProblemIR representation

`DynamicsIR` retains the mutual exclusion between `fixed_timestep` and
`adaptive_timestep`. Adaptive IR preserves:

- nullable requested `dt_initial`;
- finite positive `dt_min` and `dt_max` with ordered bounds;
- either `max_error` mode or advanced `atol/rtol` mode;
- safety and growth/shrink limits;
- optional norm and spin-rotation guards.

Deserialization of an explicit `dt_initial == dt_min` preserves that explicit
value. Missing or `null` remains omitted. Legacy payload migration is
deterministic and cannot infer intent from floating-point equality.

The integrator vocabulary adds the explicit `tangent_plane` family without
reusing `RelaxationAlgorithmIR::TangentPlaneImplicit`. Its fixed timestep and
gyromagnetic convention remain in `DynamicsIR`; requested/resolved stiff
scheme, `theta`, field splitting, linear-solver policy, temporal order, and
qualification identity are typed planner/runtime provenance. Unknown scheme
versions or a request that would drop any of these semantics fail closed.

### 4.3 Planner and capability matrix

Planner validation occurs before backend materialization. It rejects illegal
fixed/adaptive combinations, unsupported integrators, dropped guards or
tolerances, unsupported multilayer/hybrid adaptive execution, and forced
device/precision lanes without the required capability.

Capability rows are separate for explicit fixed, explicit adaptive, and stiff
time-domain integration, with backend, device, precision, supported guards,
demag realization, validation scope, and status. A narrow fixture cannot
promote a broad production claim.

(round-trip-and-failure-semantics)=

### 4.4 Requested and resolved provenance

Provenance stores typed requested and resolved policies, not a lossy string.
For adaptive mode it records requested nullable `dt_initial`, resolved first
`dt`, resolution reason `explicit` or `dt_min_default`, bounds, tolerance
mode, estimator order, controller parameters, guards, backend, device,
precision, and capability/qualification identity.

Canonical round-trips preserve requested intent.
They record resolved execution separately. Validation errors reject invalid or
lossy policies before materialization, and unsupported combinations fail closed.

### 4.5 Runtime telemetry and artifacts

Attempt telemetry is bounded and solver-owned. Each attempt produces exactly
one record containing at least:

```text
attempt, t, dt_attempt, eta, norm_defect, max_rotation,
decision, reason, dt_next, demag_iterations, demag_residual
```

Native FEM publishes the latest step trace through the versioned
`fullmag_fem_backend_solver_attempt_count_v1` and
`fullmag_fem_backend_copy_solver_attempts_v1` ABI symbols. The v1 record
remains frozen for compatibility; the additive
`fullmag_fem_backend_copy_solver_attempts_v2` record additionally carries the
executed error-norm type, active-node count, active measure, normalization
denominator, maximum scaled error, and weighted RMS. The trace capacity is 64
records, which is greater than the canonical 50-rejection budget plus the
accepted attempt. Capacity exhaustion fails the step; records are never
silently truncated. A failed outer step transaction restores the previously
published trace together with solver state.

For maximum-error mode, accepted-step telemetry converts `eta` back to the
absolute embedded vector error `eta * max_err`, so live `Error` and `MaxError`
have identical semantics. For advanced `atol + rtol` mode the scalar `eta`
remains the authoritative acceptance metric and no misleading absolute
`MaxError` comparison is published.

Required run artifacts are:

- `solver_config.json` for requested/resolved configuration and runtime
  fingerprint;
- `solver_attempts.csv` for every accepted/rejected attempt;
- `solver_steps.csv` for committed state, energy terms, torque/RHS, solve
  counts, and accepted `dt`;
- `qualification.json` for analytic expectations, measured errors/orders,
  parity budgets, and pass/fail.

For `tangent_plane`, step telemetry additionally records `theta`, linear
solver kind, preconditioner kind, requested relative/absolute residual,
achieved true residual, iteration count, convergence, tangent-constraint
leakage, maximum retraction norm defect, and autonomous energy change. The
Control Room exposes these as read-only solver diagnostics through the
existing resource-first diagnostics path; no component invents a second
solver policy or estimates convergence from wall-clock progress.

Artifact creation alone writes `qualification.json` with status
`not_evaluated`. Only the dedicated scientific qualification gate may replace
that state with pass/fail evidence.

Fixed-step FDM CUDA relaxation must compute its due `CONTROL` statistics
from the accepted endpoint, including the torque in A/m used by the stop
criterion. This applies to RK23 in both storage precisions as well as other
fixed-step integrators. A metadata-only sample with zero-initialized torque
is not evidence of equilibrium and must not satisfy torque confirmation.
The statistics stride remains explicit; this requirement does not enable
full energy reductions or alter adaptive integration. The October 24, 2026
repair is a correction to observation and stopping, not a new scientific
qualification of RK23.

Attempt trace is not a coalesced table-autosave observable. Output samples do
not redefine internal steps and may be interpolated only under an explicitly
documented dense-output contract.

### 4.6 Artifact-bound validation state and energy balance

The LLG timestep validation state is owned by
`benchmarks/fem-llg/qualification-registry-v1.json`. Its exact vocabulary is
`unvalidated`, `algebra_validated`, `physics_validated`, and
`production_qualified`. A registry row is selected only by the complete tuple

```text
capability ID, qualification ID, backend, device, precision,
integrator, timestep policy
```

and a promotion additionally binds `artifact_sha256`,
`runtime_source_inputs_sha256`, `validated_scope`, `validated_at`, and the
validator schema. Missing rows, stale or mismatched hashes, dirty runtime
sources, incomplete evidence, or absent prerequisite gates resolve to
`unvalidated`. An engine name, executable capability, or qualification ID is
never evidence by itself. FEM single precision cannot be promoted by the
current registry. The initial registry intentionally leaves every lane
`unvalidated` until fresh managed CPU, GPU, and parity artifacts carry the
exact source-provenance schema and pass the registry validator.

Every physics qualification artifact declares one energy-balance class and
its exact validator:

| `energy_balance_kind` | Required validator | Acceptance contract |
|---|---|---|
| `undriven_dissipative` | `undriven_dissipative_energy_balance.v1` | $\Delta E \le \varepsilon_E$ |
| `externally_driven` | `externally_driven_power_balance.v1` | $|\Delta E-W_\mathrm{source}+E_\mathrm{diss}|\le\varepsilon_E$ |
| `spin_torque_driven` | `spin_torque_power_balance.v1` | $|\Delta E-W_\mathrm{source}-W_\mathrm{nc}+E_\mathrm{diss}|\le\varepsilon_E$ |

Here all energies and works are in joules and `epsilon_E` is the recorded
discretization, field-solve, and energy-evaluation budget. The driven
validators require explicit source work and dissipated energy. The spin-torque
validator additionally requires the nonconservative-work term. If a backend
does not publish those observables, that scope remains unqualified; it is not
tested with the autonomous monotonic-energy rule. CPU/GPU parity requires the
same energy-balance class and validator on both lanes.

(validation)=

## 5. Validation strategy

### 5.1 Unit and contract checks

- fixed/adaptive API exclusivity and lossless serialization;
- omitted, equal-to-minimum, and explicit `dt_initial` resolution;
- finite/range validation for every controller parameter;
- shared RK23/RK45 order-aware controller golden vectors;
- accepted shrink and typed `dt_min_exhausted`;
- zero/subnormal/NaN/Inf stage injection and full rollback;
- demag nonconvergence rejection for CPU, periodic, GPU, and hybrid solves;
- exact trace replay of controller decisions.

### 5.2 Analytical checks

1. Macrospin in constant field: verify precession frequency, damping envelope,
   and norm for `alpha = 0.1, 1, 10`.
2. Periodic exchange eigenmode: verify frequency, decay, and expected temporal
   order under `dt`, `dt/2`, `dt/4`.
3. Fast linear exchange mode from the audit: a decaying exact mode must not be
   accepted as a growing numerical mode.
4. Autonomous relax-to-run: verify state handoff, fresh fields, run-clock
   semantics, and energy descent within the computed error budget.
5. Tangent-plane macrospin: verify nonzero precession, Gilbert damping envelope,
   first-order convergence, and distinction from the relaxation minimizer.
6. Tangent-plane periodic exchange eigenmode: verify first-order common-time
   convergence, decay, and absence of the explicit `dt proportional to h^2`
   stability failure across the checked mesh/timestep matrix.
7. Tangent-plane failure injection: prove linear-solve nonconvergence,
   endpoint-refresh failure, and final-statistics failure restore the complete
   pre-attempt state.

### 5.3 Cross-backend checks

- FDM CPU double as structured-grid reference against CUDA double;
- FEM CPU FP64 before FEM GPU FP64;
- common-time trajectory, energy, torque, accepted-step trace, and demag
  residual comparisons;
- no forced-device fallback;
- FP32 remains unqualified until separate budgets pass.

### 5.4 Production fixture

The reduced periodic-antidot fixture must use a repository-owned,
deterministic mesh asset and preserve periodic `x/y`, open `z`,
`periodic_airbox_k0`, material parameters, field, and strict relaxation
certificate from the audited case. Geometry/mesh reduction requires an
explicit checked-in definition; it must not be invented by a test harness.

The approved reduced fixture is
`examples/assets/fem_periodic_antidot_llg_qualification.mesh.json`, with
SHA-256
`087b87f922c17b1200d7adc4011721f34e7998b1939907677a06e0df6ab35540`.
Its checked-in problem manifest records the complete reduction rule. The
shared-domain mesh has 1781 nodes, 8530 tetrahedra, 1769 magnetic tetrahedra,
6761 air tetrahedra, 623 magnetic nodes, and 384 certified periodic node
pairs. The physical cell is `80 nm x 80 nm x 8 nm`, the central hole radius is
`10 nm`, and the full periodic-airbox extent is `80 nm x 80 nm x 72 nm`.
Region marker 0 is air, marker 1 is the magnetic body, and marker 2 is the
conformal magnetic refinement region. Changing any count, marker, extent,
periodic certificate, or asset hash creates a different fixture and requires
review rather than silently updating the validator.

The production relax-to-run gate uses `alpha=10`, `g=2.115`, an external
field of `10 mT` along `+x`, strict projected-gradient BB relaxation to
`max_torque <= 500 A/m`, and RK45 with explicit `dt_initial=1e-15 s`,
`dt_min=1e-16 s`, `dt_max=1e-14 s`, and `max_err=1e-6`. The run advances one
common physical interval of `1e-15 s`. CPU and GPU must each prove a bitwise
exact persisted `relax.m_final -> run.m_initial` transfer; normalization may
not perturb an already-unit FP64 continuation state. The GPU lane must execute
CUDA RK kernels and device Hypre Poisson with fallback forbidden.

### 5.5 Managed gates

The canonical native FEM gate must build and run the adaptive controller and
LLG RHS contracts in addition to the existing explicit-RK targets. Separate
managed recipes qualify exact relax-to-run energy descent and, later, the CPU
and GPU stiff lanes. Host-only builds are diagnostics, not production proof.

The explicit-FEM qualification recipe writes a machine-readable
`qualification.json`; a zero exit status without that validated artifact is
not qualification. The first lane is FEM CPU FP64 and uses the production C
ABI, RK stepper, field assembly, energy evaluation, and state transfer:

- a uniform P1 tetrahedron in a constant `+z` field, initially
  `m=(0.6,0,0.8)`, is integrated with RK45 for
  `alpha={0.1,1,10}` and compared with the exact Gilbert macrospin solution
  `m_z=tanh(atanh(m_z0)+lambda*t)`,
  `phi=phi0+omega*t`, where
  `omega=gamma_mu0*H/(1+alpha^2)` and `lambda=alpha*omega`;
- a non-constant transverse eigenvector of the production P1 exchange
  operator is measured from the operator itself, then its small-amplitude
  frequency, decay, and RK45 temporal order are checked at common physical
  times for `dt`, `dt/2`, and `dt/4`;
- the fastest measured exchange mode is launched with an intentionally large
  adaptive first proposal; acceptance is forbidden while its amplitude grows
  relative to the analytically decaying envelope;
- direct minimization followed by RK45 on the same backend handle proves exact
  state ownership, zero physical run clock before the first RK attempt, fresh
  endpoint fields, converged demag where enabled, and autonomous energy descent
  within the recorded numerical budget.

The GPU FP64 lane must consume the same checked-in inputs and analytic
expectations, compare at common physical times, and prove strict device
execution without fallback. It may have device-specific numerical budgets but
must not replace the CPU oracle or silently reduce the fixture. FP32 remains a
separate unqualified capability.

The managed production evidence is generated by
`verify-fem-llg-time-domain-qualification-production` for the analytic
fixtures and `verify-fem-llg-periodic-antidot-qualification-production` for
the production mesh/runtime path. The latter independently validates CPU and
GPU artifacts and then compares the post-relax LLG increment at the common
physical time. It publishes the sign and magnitude of each lane's energy
change, demag residual, controller eta, PBC seam diagnostics, and
`m`/`H_demag`/`demag_phi` snapshots. Independently relaxed CPU/GPU endpoints
are not asserted bitwise equal; parity applies to the subsequent common-time
increment, while each relaxation must independently hold a strict certificate.

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] planner and capability matrix
- [ ] requested/resolved provenance
- [ ] FDM CPU
- [ ] FDM CUDA FP64
- [ ] FDM CUDA FP32 qualification
- [x] FEM CPU explicit
- [x] FEM GPU explicit FP64
- [ ] FEM GPU explicit FP32 qualification
- [ ] stiff FEM CPU time-domain integrator
- [ ] stiff FEM GPU time-domain integrator
- [ ] hybrid backend
- [ ] OpenAPI and Control Room
- [x] solver attempt/step artifacts
- [x] explicit FEM analytical and CPU/GPU FP64 qualification
- [x] canonical documentation contract

(limitations)=

## 7. Known limits and deferred work

- This note freezes the stiff-lane requirements but does not declare an
  implicit scheme qualified before its separate publication-level discrete
  formulation and RED fixtures exist.
- Energy monotonicity is not a pathwise invariant for explicitly driven,
  spin-torque, or stochastic runs; provenance must identify those exceptions.
- Explicit adaptive RK remains stability-limited even after local-error and
  geometry guards are corrected.
- Exact dense output is method-specific and remains unavailable unless
  implemented and qualified.
- The approved reduced periodic-antidot fixture qualifies the explicit FEM
  FP64 path only; it does not qualify FP32 or the stiff tangent-plane lanes.

(scientific-bibliography)=

## 8. References

- MuMax3 API, adaptive timestep variables and fixed-step override:
  `https://mumax.github.io/api.html`
- COMSOL time-dependent solver reference, used only as a solver-semantics and
  observability comparison:
  `https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_solver.36.139.html`
- Local MuMax3 source: `external_solvers/3/engine/`
- Local TetraX source: `external_solvers/TetraX/`

(source-code-index)=

## 9. Source Code Index

| Repository path | Symbol | Responsibility |
|---|---|---|
| `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` | `evaluate_rk_stage_rhs` | Compose FEM CPU effective fields, LLG contribution, and enabled direct-torque terms for an RK stage. |
| `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu` | `gpu_rk_compute_rhs_for_magnetization` | Compose the FEM GPU effective-field, LLG, and direct-torque RHS for an RK stage. |
| `backends/fem/cpu/mfem/interactions/effective_field.cpp` | `compute_effective_fields_for_magnetization` | Assemble the FEM CPU effective field consumed by the time integrator. |
| `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu` | `gpu_rk_compute_effective_field_for_magnetization` | Assemble the FEM GPU effective field for a magnetization state. |
| `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `compute_adaptive_error_norm` | Compute the maximum active-node scaled embedded error. |
| `native/include/fullmag_adaptive_step_decision.hpp` | `decide` | Implement the shared order-aware scalar adaptive timestep decision. |
| `crates/fullmag-ir/src/study.rs` | `AdaptiveTimeStepIR` | Preserve requested adaptive-timestep policy in ProblemIR. |
| `crates/fullmag-ir/src/validation.rs` | `validate_adaptive_timestep` | Reject invalid adaptive settings and incompatible integrators. |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Expose the public study-level solver authoring API. |
| `backends/fem/tests/llg_rhs_contract.cpp` | `llg_rhs_uses_llg_gilbert_form_and_nodewise_damping` | Check the FEM LLG RHS convention and nodewise damping behavior. |
| `backends/fem/tests/adaptive_dt_contract.cpp` | `adaptive_error_norm_uses_nodewise_vector_l2_scale` | Check the adaptive vector-error norm against nodewise golden expectations. |
| `backends/fem/tests/adaptive_dt_contract.cpp` | `shared_golden_vectors_match_cpu_and_gpu_host_adapters` | Check shared adaptive-controller decisions across CPU and GPU host adapters. |
| `packages/fullmag-py/tests/test_llg_solver_contract.py` | `test_adaptive_policy_preserves_omitted_initial` | Check that omitted initial timestep intent survives Python-to-IR lowering. |
| `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md` | `DOC-ANCHOR:planned-dissipation-invariant` | Scientific dissipation requirement only; it does not claim production qualification. |
| `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md` | `DOC-ANCHOR:planned-tangent-plane-weak-form` | Future tangent-plane formulation only; no present physical-time implementation is claimed. |
