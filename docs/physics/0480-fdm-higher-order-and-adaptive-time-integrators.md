
# Higher-order and adaptive time integrators for FDM LLG

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-24
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0200-llg-exchange-reference-engine.md`
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0440-fdm-interfacial-dmi.md`
  - `docs/physics/0460-fdm-bulk-dmi.md`

## 1. Problem statement

This note defines how Fullmag should extend the current **Heun-only** FDM time integrator
toward a family of **higher-order** and **adaptive-timestep** explicit solvers for LLG:

- SSPRK3 / RK3,
- classical RK4,
- embedded RK45 / Dormand–Prince 5(4),
- embedded RK56 / Verner-style 6(5) family.

The goal is not only to add more Butcher tableaux.
The goal is to add them in a way consistent with:

- reduced-magnetization geometry `|m|=1`,
- GPU execution on structured grids,
- expensive nonlocal demag stages,
- one shared public API across backends.

## 2. Physical model

### 2.1 Governing equation

The reduced-magnetization LLG equation is

\[
\frac{dm}{dt}
=
-\frac{\gamma}{1+\alpha^2}
\left[
m\times H_{\mathrm{eff}}
+
\alpha\, m\times (m\times H_{\mathrm{eff}})
\right]
=: f(m,t).
\]

Here

\[
H_{\mathrm{eff}}
=
H_{\mathrm{ex}}
+
H_{\mathrm{demag}}
+
H_{\mathrm{DMI}}
+
H_{\mathrm{ext}}
+\cdots
\]

is the total effective field.

For exact continuum dynamics,

\[
m\cdot f(m,t) = 0,
\]

so the flow is tangent to the unit sphere.

### 2.2 Semi-discrete FDM ODE system

After FDM discretization on `N` active cells, the solver evolves

\[
\dot y = F(y,t),
\qquad
y \in \mathbb{R}^{3N},
\]

where each cell stores one reduced vector `m_i`.
Because the continuous dynamics is tangent but the discrete stage arithmetic is finite precision,
the numerical method must control both:

- local truncation error,
- norm drift `||m_i|-1|`.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m_i` | reduced magnetization at cell `i` | 1 |
| `H_eff` | effective field | A/m |
| `\gamma` | gyromagnetic ratio | m/(A·s) |
| `\alpha` | Gilbert damping | 1 |
| `dt` | timestep | s |
| `atol, rtol` | local error tolerances | 1 |
| `\eta` | normalized error estimate | 1 |

### 2.4 Assumptions and approximations

This note covers explicit one-step Runge–Kutta families only.
Deferred:

- tangent-plane integrators,
- Cayley / midpoint geometric integrators,
- Rosenbrock / IMEX methods,
- fully implicit FEM-oriented schemes.

## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.1 Unified explicit RK stage model

For an `s`-stage explicit RK method, stage states satisfy

\[
Y^{(j)} = y_n + dt \sum_{\ell=1}^{j-1} a_{j\ell} K^{(\ell)},
\qquad
K^{(j)} = F(Y^{(j)}, t_n + c_j dt).
\]

The accepted step is

\[
y_{n+1} = y_n + dt \sum_{j=1}^s b_j K^{(j)}.
\]

For an embedded pair, also compute

\[
\tilde y_{n+1} = y_n + dt \sum_{j=1}^s \tilde b_j K^{(j)},
\]

and use

\[
e_{n+1} = y_{n+1} - \tilde y_{n+1}
\]

as the local error estimator.

#### 3.1.2 Sphere handling

For the first production explicit RK rollout, use the following policy:

1. each stage state `Y^{(j)}` is normalized cellwise before field evaluation if norm drift exceeds a stage threshold;
2. each accepted step is normalized cellwise:
   \[
   m_i \leftarrow \frac{m_i}{|m_i|};
   \]
3. rejection/acceptance uses both embedded local error and norm defect diagnostics.

This is not a fully geometric integrator, but it is practical, robust, and compatible with GPU kernels.

#### 3.1.3 Error norm and adaptive controller

For each active cell define

\[
\eta_i
=
\frac{\|e_i\|_2}{\mathrm{atol} + \mathrm{rtol}\,\max(\|m_i^{hi}\|_2,1)}.
\]

Use a global control metric

\[
\eta = \max_i \eta_i.
\]

Accept the step if

\[
\eta \le 1
\]

and the post-step norm defect is below a configured threshold.

Recommended timestep controller:

\[
dt_{\mathrm{new}}
=
\mathrm{safety}\cdot dt \cdot \eta^{-1/q},
\]

where `q` is the estimator order:

- RK3 step-doubling: `q=4`,
- RK4 step-doubling: `q=5`,
- Dormand–Prince 5(4): `q=5`,
- Verner 6(5): `q=6`.

Clamp with user-configurable growth/shrink limits, e.g.

\[
0.2 \le \frac{dt_{\mathrm{new}}}{dt} \le 5.0.
\]

#### 3.1.4 Recommended rollout order

##### A. SSPRK3 / RK3

Use SSPRK3 first as the minimal higher-order upgrade over Heun.

Pros:

- modest stage count,
- stable for purely local terms,
- easy to validate.

Adaptive variant:
use **step doubling**:

- one full SSPRK3 step of size `dt`,
- two half-steps of size `dt/2`,
- difference = error estimate.

This doubles work, so SSPRK3 adaptive is a bootstrap, not the final default.

##### B. Classical RK4

RK4 is a familiar reference method and an excellent validation tool.

Pros:

- ubiquitous,
- high-quality reference traces,
- strong user familiarity.

Adaptive variant:
again use step doubling.
This is expensive but very useful as a calibration reference.

##### C. Dormand–Prince 5(4) (recommended production default)

Use a 5(4) embedded pair with FSAL behavior as the first production adaptive method.

Why it is the best first production adaptive choice:

- better accuracy/cost than step-doubled RK4,
- one built-in error estimate,
- FSAL reduces one RHS evaluation on accepted steps,
- very good general-purpose behavior.

In demag-heavy runs, saved RHS evaluations matter because each stage may trigger one FFT-based demag solve.

##### D. RK56 / Verner-style 6(5)

Add a higher-order embedded pair once RK45 is stable.

Use cases:

- highly accurate dynamics traces,
- smooth precessional trajectories,
- benchmark-grade convergence studies.

Caveat:
more stages mean more demag evaluations, so RK56 should not become the blind default.

#### 3.1.5 GPU architecture for explicit RK

Each stage requires:

1. assemble `H_eff`,
2. evaluate `F(m)`,
3. accumulate stage combination.

Recommended SoA buffers:

- `m`,
- `k1..ks`,
- `y_stage`,
- `m_trial_hi`,
- `m_trial_lo`,
- scratch reductions.

Demag-specific recommendation:

- cache FFT plans across the whole run,
- reuse demag work buffers across stages,
- if using FSAL, reuse the last accepted RHS as the first stage of the next accepted step where valid.

The adaptive controller requires reductions for:

- max embedded error,
- max norm defect,
- max `|H_eff|`,
- optional max `|dm/dt|`.

Those reductions should remain GPU-resident until the final scalar is copied back.

#### 3.1.6 Staged multilayer CUDA fixed-step RK23 boundary

For `multilayer_convolution` plans that execute through the staged native CUDA
v2 boundary, fixed-step Bogacki-Shampine RK23 is a legal explicit stepper when
the plan has no `adaptive_timestep`. The runner may use a configured fixed
timestep or its existing default, and each native step requires `dt_seconds >
0`. It uses
the third-order accepted weights

\[
m_{n+1} =
\mathcal{N}\left(
m_n + dt\left(\frac{2}{9}k_1 + \frac{1}{3}k_2 + \frac{4}{9}k_3\right)
\right),
\]

with stage locations `c = (0, 1/2, 3/4)` and cellwise normalization
`\mathcal{N}` at each staged state and accepted output. Each RHS evaluation
must use the same staged multilayer field realization as Heun and RK4:
optional multilayer demag, layer-local exchange, requested uniform external
field, per-layer uniform uniaxial/cubic anisotropy, and global
interfacial/bulk DMI.

This fixed-step capability does **not** implement the embedded second-order
error estimator, FSAL reuse, adaptive accept/reject/retry, or ABM/RK45 staged
multilayer execution. A request carrying `adaptive_timestep` must continue to
fail before staged CUDA execution until the device-resident adaptive lifecycle
is implemented and validated.

#### 3.1.7 Stability guardrails

Pure local error control is not enough in micromagnetics because exchange and DMI can make the problem stiff.

Recommended additional guards:

- maximum allowed spin rotation per step,
- maximum allowed relative change in `H_eff`,
- hard `dt_max` from user or planner,
- optional heuristic initial timestep from
  \[
  dt \sim \frac{1}{\gamma \max |H_{\mathrm{eff}}|}.
  \]

If repeated rejections occur, log the reason and suggest a stiffer integrator family in the future.

### 3.2 FEM

See the FEM-specific companion note:

- `0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Current API only allows

```python
fm.LLG(integrator="heun", fixed_timestep=...)
```

Recommended extension:

```python
fm.LLG(
    integrator="dopri54",   # or "ssprk3", "rk4", "verner65"
    fixed_timestep=None,
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

The public surface should not expose method-specific tableau coefficients.

### 4.2 ProblemIR representation

Recommended additions:

- extend `IntegratorChoice`,
- add `AdaptiveTimeStepIR`,
- add optional `StepperDiagnosticsIR` / solver-stats fields.

Example:

```json
{
  "kind": "llg",
  "gyromagnetic_ratio": 2.211e5,
  "integrator": "dopri54",
  "fixed_timestep": null,
  "adaptive_timestep": {
    "atol": 1e-5,
    "rtol": 1e-4,
    "dt_initial": 1e-15,
    "dt_min": 1e-18,
    "dt_max": 1e-11,
    "safety": 0.9,
    "growth_limit": 5.0,
    "shrink_limit": 0.2,
    "norm_tolerance": 1e-6
  }
}
```

### 4.3 Planner and capability-matrix impact

Planner must:

- reject adaptive settings on unsupported backends,
- provide backend-specific notes about expected stiffness,
- record actual controller parameters in provenance,
- estimate stage-buffer memory.

Capability matrix should split:

- fixed-step RK support,
- adaptive embedded-pair support,
- public-executable status by backend and precision.

## 5. Validation strategy

### 5.1 Analytical checks

- convergence order on smooth exchange-only problems,
- timestep-halving studies against known Heun/RK4 baselines,
- norm-drift checks.

### 5.2 Cross-backend checks

Once FEM explicit integrators exist:

- same problem, same tolerances,
- compare accepted-step traces `dt(t)`,
- compare `E(t)` and magnetization observables.

### 5.3 Regression tests

- SSPRK3 vs RK4 vs DOPRI on exchange-only strip,
- accepted/rejected-step accounting,
- CPU vs CUDA parity on adaptive controller outputs,
- determinism of accepted-step sequence in fixed precision,
- demag-heavy benchmark with cached FFT plans.

## 6. Completeness checklist

- [ ] Python API
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

- no geometric tangent-plane integrators in this note,
- no implicit or IMEX methods,
- renormalized explicit RK may reduce formal order in extreme cases,
- explicit adaptive methods may still struggle on very stiff exchange-dominated meshes,
- demag cost can dominate high-stage methods.

## 8. References

Internal references:

- `docs/physics/0200-llg-exchange-reference-engine.md`
- `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`

## 9. Canonical time-policy reconciliation

Contracts: `LLG-TD-POLICY-V1`, `LLG-TD-ATTEMPT-V1`,
`LLG-TD-FIRST-DT-V1`, `LLG-TD-MAX-ERR-V1`, `LLG-TD-ATOMIC-V1`.

The approved cross-backend contract is note 0960. In the convenience API,
`fix_dt` is fixed-only. Adaptive RK uses `dt_initial`, `dt_min`, `dt_max`, and
absolute `max_err`; when `dt_initial` is omitted, requested intent remains
omitted and the resolved first attempt is exactly `dt_min`. The advanced
`atol`/`rtol` object remains a separate tolerance mode.

No FDM realization may infer omission from `dt_initial == dt_min`, substitute
a global timestep sentinel, or force-accept an error failure at the floor.
Such a failure is the typed `dt_min_exhausted` result. Fixed embedded RK23 or
RK45 does not enter an adaptive retry lifecycle. A stiff time-domain method,
when available, is an explicit user selection and never a hidden fallback.
