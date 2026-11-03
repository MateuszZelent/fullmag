
# Higher-order and adaptive time integrators for FDM LLG

- Status: implementation-mapped design note; runtime qualification is workload-specific
- Owners: Fullmag core
- Last updated: 2026-11-03
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

(problem-statement)=
## 1. Problem statement

This note retains the historical explicit-RK design and maps it to the current
implementation. FDM is no longer Heun-only: the single-grid CPU reference and
native CUDA owners contain Heun, RK4, RK23, RK45 and ABM3 paths. ABM3 is a
multistep method outside the RK derivation below. SSPRK3 and RK56 remain design
proposals, not additional public integrator tokens or qualified realizations.
The historical research families were:

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

### Current realization boundary and evidence

| Solver | Device | Implementation scope and evidence |
|---|---|---|
| FDM | CPU | Rust reference single-grid Heun/RK4/RK23/RK45/ABM3 owners exist. Multilayer legality is separately gated. Source mapping is not a convergence or runtime qualification receipt. |
| FDM | GPU | Native CUDA single-grid explicit/adaptive owners exist. Staged multilayer supports fixed Heun/RK4/RK23; public adaptive multilayer remains rejected. FP32 and FP64 are separate realizations and need their own parity evidence. |
| FEM | CPU | Separate MFEM realization in notes 0490/0960; not qualified by this FDM note or the authoring alias. |
| FEM | GPU | Separate MFEM/CUDA realization in notes 0490/0960; no new device/runtime evidence in this note. |

Requested `rk32` or `bs23` authoring selects the existing `rk23` method. It
cannot bypass the public multilayer adaptive gate. SSPRK3/RK56 and the
proportional-controller research formulas below are retained as proposals;
they are not a statement that every backend implements them.

(governing-equations)=
### 2.1 Governing equation

The reduced-magnetization LLG equation is

```{math}
:label: eq-fdm-rk-llg
\frac{dm}{dt}
=
-\frac{\gamma}{1+\alpha^2}
\left[
m\times H_{\mathrm{eff}}
+
\alpha\, m\times (m\times H_{\mathrm{eff}})
\right]
=: f(m,t).
```

Here

```{math}
:label: eq-fdm-rk-effective-field
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
```

is the total effective field.

For exact continuum dynamics,

```{math}
:label: eq-fdm-rk-tangent
m\cdot f(m,t) = 0,
```

so the flow is tangent to the unit sphere.

### 2.2 Semi-discrete FDM ODE system

After FDM discretization on `N` active cells, the solver evolves

```{math}
:label: eq-fdm-rk-ode
\dot y = F(y,t),
\qquad
y \in \mathbb{R}^{3N},
```

where each cell stores one reduced vector `m_i`.
Because the continuous dynamics is tangent but the discrete stage arithmetic is finite precision,
the numerical method must control both:

- local truncation error,
- norm drift `||m_i|-1|`.

(symbols-and-si-units)=
### 2.3 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $m$ | reduced magnetization | $1$ |
| $m_i$ | reduced magnetization of cell i | $1$ |
| $H_{\mathrm{eff}}$ | effective field | $\mathrm{A\,m^{-1}}$ |
| $H_{\mathrm{ex}}$ | exchange field | $\mathrm{A\,m^{-1}}$ |
| $H_{\mathrm{demag}}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $H_{\mathrm{DMI}}$ | DMI field | $\mathrm{A\,m^{-1}}$ |
| $H_{\mathrm{ext}}$ | external field | $\mathrm{A\,m^{-1}}$ |
| $\gamma$ | gyromagnetic ratio | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $t$ | physical time | $\mathrm{s}$ |
| $dt$ | attempt timestep | $\mathrm{s}$ |
| $dt_{\mathrm{new}}$ | proposed next timestep | $\mathrm{s}$ |
| $f$ | cell LLG right-hand side | $\mathrm{s^{-1}}$ |
| $F$ | semi-discrete LLG right-hand side | $\mathrm{s^{-1}}$ |
| $y$ | concatenated reduced state | $1$ |
| $y_n$ | accepted reduced state | $1$ |
| $y_{n+1}$ | high-order candidate | $1$ |
| $\tilde y_{n+1}$ | embedded low-order candidate | $1$ |
| $N$ | number of active cells | $1$ |
| $i$ | active-cell index | $1$ |
| $n$ | accepted-step index | $1$ |
| $s$ | number of RK stages | $1$ |
| $j$ | RK stage index | $1$ |
| $\ell$ | previous RK stage index | $1$ |
| $Y^{(j)}$ | unprojected RK stage state | $1$ |
| $K^{(j)}$ | RK stage right-hand side | $\mathrm{s^{-1}}$ |
| $a_{j\ell}$ | RK tableau stage weights | $1$ |
| $b_j$ | high-order RK weights | $1$ |
| $\tilde b_j$ | embedded RK weights | $1$ |
| $c_j$ | RK stage time fraction | $1$ |
| $e_{n+1}$ | embedded state difference | $1$ |
| $e_i$ | cell embedded state difference | $1$ |
| $m_i^{hi}$ | high-order cell state | $1$ |
| $\mathrm{atol}$ | absolute reduced-state tolerance | $1$ |
| $\mathrm{rtol}$ | relative reduced-state tolerance | $1$ |
| $\eta_i$ | normalized cell error | $1$ |
| $\eta$ | global normalized error | $1$ |
| $q$ | error-estimator controller exponent denominator | $1$ |
| $\mathrm{safety}$ | controller safety factor | $1$ |
| $\mathcal{N}$ | cellwise unit-vector projection | $1$ |
| $k_1,k_2,k_3$ | Bogacki-Shampine stage derivatives | $\mathrm{s^{-1}}$ |
| $m_i^n$ | accepted cell state used for error scaling | $1$ |
| $m_i^{stage}$ | current cell stage state used for error scaling | $1$ |
| $\epsilon$ | positive floor of error scale | $1$ |

(assumptions-and-validity)=
### 2.4 Assumptions and approximations

This note covers explicit one-step Runge–Kutta families only.
Deferred:

- tangent-plane integrators,
- Cayley / midpoint geometric integrators,
- Rosenbrock / IMEX methods,
- fully implicit FEM-oriented schemes.

(discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.1 Unified explicit RK stage model

For an `s`-stage explicit RK method, stage states satisfy

```{math}
:label: eq-fdm-rk-stage
Y^{(j)} = y_n + dt \sum_{\ell=1}^{j-1} a_{j\ell} K^{(\ell)},
\qquad
K^{(j)} = F(Y^{(j)}, t_n + c_j dt).
```

The accepted step is

```{math}
:label: eq-fdm-rk-accepted
y_{n+1} = y_n + dt \sum_{j=1}^s b_j K^{(j)}.
```

For an embedded pair, also compute

```{math}
:label: eq-fdm-rk-embedded
\tilde y_{n+1} = y_n + dt \sum_{j=1}^s \tilde b_j K^{(j)},
```

and use

```{math}
:label: eq-fdm-rk-error
e_{n+1} = y_{n+1} - \tilde y_{n+1}
```

as the local error estimator.

#### 3.1.2 Sphere handling

The current resolved
`unit_sphere` plan token requires projection of intermediate RK states; this is
not a new user-selectable threshold policy. The actual per-method realization
is mapped in section 10 and must be checked for its selected lane.

Each intermediate RK state is projected cellwise before field evaluation;
the accepted state is projected as well:

```{math}
:label: eq-fdm-rk-normalize
m_i \leftarrow \frac{m_i}{|m_i|}.
```

Embedded-error, norm-defect and spin-rotation rejection are governed by the
actual selected runtime policy. The historical stage-threshold proposal is
not an additional public projection mode.

This is not a fully geometric integrator, but it is practical, robust, and compatible with GPU kernels.

#### 3.1.3 Error norm and adaptive controller

For the current CPU advanced mode with positive relative tolerance, define

```{math}
:label: eq-fdm-rk-cell-error
\eta_i
=
\frac{\|e_i\|_2}{\mathrm{atol} + \mathrm{rtol}\,\max(\|m_i^n\|_2,\|m_i^{stage}\|_2,\epsilon)}.
```

Here $\epsilon=10^{-30}$ prevents a zero scale. With `rtol=0`, the CPU
reducer returns the raw embedded vector norm and compares it with `atol`;
convenience `max_err` uses that absolute mode. This source mapping is not a
new CUDA parity claim.

Use a global control metric

```{math}
:label: eq-fdm-rk-error-norm
\eta = \max_i \eta_i.
```

Accept the step if

```{math}
:label: eq-fdm-rk-accept
\eta \le 1
```

and the post-step norm defect is below a configured threshold.

Historical proportional-controller proposal (actual acceptance, PI history,
representable shrink and floor handling are owned by note 0960 and the runtime):

```{math}
:label: eq-fdm-rk-controller-proposal
dt_{\mathrm{new}}
=
\mathrm{safety}\cdot dt \cdot \eta^{-1/q},
```

where `q` is the estimator order:

- RK3 step-doubling: `q=4`,
- RK4 step-doubling: `q=5`,
- Dormand–Prince 5(4): `q=5`,
- Verner 6(5): `q=6`.

Clamp with user-configurable growth/shrink limits, e.g.

```{math}
:label: eq-fdm-rk-clamp-proposal
0.2 \le \frac{dt_{\mathrm{new}}}{dt} \le 5.0.
```

(fdm-rk-research-proposals)=
#### 3.1.4 Historical research rollout order

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
the plan has no `adaptive_timestep`. The public runner requires an explicit positive fixed timestep; the native
step also requires `dt_seconds > 0`. No adaptive default is admitted here. It uses
the third-order accepted weights

```{math}
:label: eq-fdm-rk-bs23
m_{n+1} =
\mathcal{N}\left(
m_n + dt\left(\frac{2}{9}k_1 + \frac{1}{3}k_2 + \frac{4}{9}k_3\right)
\right),
```

with stage locations `c = (0, 1/2, 3/4)` and cellwise normalization
`\mathcal{N}` at each staged state and accepted output. Each RHS evaluation
must use the same staged multilayer field realization as Heun and RK4:
optional multilayer demag, layer-local exchange, requested uniform external
field, per-layer uniform uniaxial/cubic anisotropy, and global
interfacial/bulk DMI and the separately owned per-layer rotated interfacial DMI.

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
  ```{math}
:label: eq-fdm-rk-initial-dt-proposal
dt \sim \frac{1}{\gamma \max |H_{\mathrm{eff}}|}.
```

If repeated rejections occur, log the reason and suggest a stiffer integrator family in the future.

### 3.2 FEM

See the FEM-specific companion note:

- `0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

(python-api)=
### 4.1 Python API surface

The embedded Bogacki–Shampine method of order 3(2) has canonical token `rk23`.
`rk32` and `bs23` are authoring aliases of that same tableau; model validation
and Python export/ProblemIR normalize them to `rk23`. They do not advertise a
second method or broaden any backend's execution capability. In particular,
the staged multilayer adaptive gate described above remains closed until its
native acceptance/rejection lifecycle is implemented and qualified.

The first example constructs a fixed-step study, requiring no backend execution:

```python
# %% Stage-first fixed RK23 authoring
import fullmag as fm

study = fm.study("fdm_rk32_alias_contract")
study.engine("fdm")
study.device("cpu", precision="double")
study.cell(5e-9, 5e-9, 5e-9)
body = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name="film")
body.Ms, body.Aex, body.alpha = 800e3, 13e-12, 1.0
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.solver(integrator="rk32", fix_dt=1e-15)
study.stages.add_run(until=1e-12)
```

The public model form is:

```python
# %% Advanced model round-trip (no solver execution)
import fullmag as fm

model = fm.LLG(
    integrator="rk32",  # exported as canonical "rk23"
    fixed_timestep=None,
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1e-5,
        rtol=1e-4,
        dt_initial=1e-15,
        dt_min=1e-18,
        dt_max=1e-11,
        safety=0.9,
        growth_limit=5.0,
        shrink_limit=0.2,
        norm_tolerance=1e-6,
    ),
)
```

The public surface should not expose method-specific tableau coefficients.
For `study.solver`, the same alias can be used with `dt_initial` and `max_err`;
`fix_dt` remains mutually exclusive with the adaptive controls. Damping-only
LLG relaxation uses this integrator with precession disabled and its own
relaxation clock; it does not advance the physical time-domain clock.

### Complete time-policy parameter mapping

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| fm.LLG.gamma | float | 2.211e5 | $\mathrm{m\,A^{-1}\,s^{-1}}$ | positive finite | LLG gyromagnetic coefficient | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.gyromagnetic_ratio |
| fm.LLG.integrator | str | auto | $1$ | supported token; rk32 and bs23 normalize to rk23; dp54 to rk45 | requested method family | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.integrator |
| fm.LLG.fixed_timestep | float \| None | None | $\mathrm{s}$ | positive finite; excludes adaptive_timestep | fixed physical step | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.fixed_timestep |
| fm.LLG.adaptive_timestep | AdaptiveTimestep \| None | None | $1$ | adaptive method or auto; excludes fixed_timestep | embedded controller configuration | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep |
| fm.LLG.field_refresh | FieldRefreshPolicy \| None | None | $1$ | validated optional field-refresh policy | expensive operator cadence | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.field_refresh |
| fm.AdaptiveTimestep.atol | float | 1e-6 | $1$ | nonnegative finite; atol and rtol not both zero | absolute reduced-state error tolerance | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.atol |
| fm.AdaptiveTimestep.rtol | float | 1e-3 | $1$ | nonnegative finite; atol and rtol not both zero | relative reduced-state error tolerance | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.rtol |
| fm.AdaptiveTimestep.dt_initial | float \| None | None | $\mathrm{s}$ | positive finite or None; within dt_min and dt_max | requested first attempt; None preserved | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.dt_initial |
| fm.AdaptiveTimestep.dt_min | float | 1e-15 | $\mathrm{s}$ | positive finite | minimum permitted attempt | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.dt_min |
| fm.AdaptiveTimestep.dt_max | float \| None | None | $\mathrm{s}$ | positive finite or None; not below dt_min | maximum permitted attempt | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.dt_max |
| fm.AdaptiveTimestep.safety | float | 0.9 | $1$ | 0 < safety <= 1 | controller safety factor | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.safety |
| fm.AdaptiveTimestep.growth_limit | float | 2.0 | $1$ | finite > 1 | maximum timestep growth ratio | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.growth_limit |
| fm.AdaptiveTimestep.shrink_limit | float | 0.2 | $1$ | 0 < shrink_limit < 1 | minimum timestep ratio | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.shrink_limit |
| fm.AdaptiveTimestep.max_spin_rotation | float \| None | None | $\mathrm{rad}$ | positive finite or None | optional maximum spin rotation | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.max_spin_rotation |
| fm.AdaptiveTimestep.norm_tolerance | float \| None | None | $1$ | positive finite or None | optional norm-defect threshold | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.norm_tolerance |
| fm.FieldRefreshPolicy.demag_interval_s | float \| None | None | $\mathrm{s}$ | positive finite or None | demag refresh interval | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.field_refresh.demag_interval_s |
| study.solver.integrator | str \| None | None | $1$ | validated by study.solver; fixed/adaptive controls mutually exclusive | method with canonical alias normalization | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.integrator |
| study.solver.fix_dt | float \| None | None | $\mathrm{s}$ | validated by study.solver; fixed/adaptive controls mutually exclusive | fixed step excluding adaptive controls | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.fixed_timestep |
| study.solver.dt_initial | float \| None | None | $\mathrm{s}$ | validated by study.solver; fixed/adaptive controls mutually exclusive | first adaptive attempt; omission retained | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.dt_initial |
| study.solver.dt_min | float \| None | None | $\mathrm{s}$ | validated by study.solver; fixed/adaptive controls mutually exclusive | minimum adaptive attempt | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.dt_min |
| study.solver.dt_max | float \| None | None | $\mathrm{s}$ | validated by study.solver; fixed/adaptive controls mutually exclusive | maximum adaptive attempt | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.dt_max |
| study.solver.max_err | float \| None | None | $1$ | validated by study.solver; fixed/adaptive controls mutually exclusive | absolute reduced-magnetization error; rtol zero | FDM CPU/CUDA single-grid; staged multilayer adaptive rejected; FEM governed by 0490/0960 | study.dynamics.adaptive_timestep.atol |

Private normalization `_tolerance_mode` is `advanced` for the explicit object
and `max_error` for convenience `max_err`; it is exported as `tolerance_mode`.
An omitted `dt_initial` stays omitted in requested intent; resolution starts at
`dt_min`. `norm_tol` is not a public constructor parameter; use `norm_tolerance`.

(problem-ir)=
### 4.2 ProblemIR representation

Current symbols are `IntegratorChoice`, `FdmProjectionPolicyIR` and
`AdaptiveTimeStepIR`. The JSON below is the output of the advanced model above
via `model.to_ir()`; it preserves the canonical method and advanced tolerance
mode, rather than inventing a separate `dopri54` IR token.

```json
{
  "kind": "llg",
  "gyromagnetic_ratio": 2.211e5,
  "integrator": "rk23",
  "fixed_timestep": null,
  "adaptive_timestep": {
    "tolerance_mode": "advanced",
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

(validation)=
## 5. Validation strategy

### 5.1 Analytical checks

- convergence order on smooth exchange-only problems,
- timestep-halving studies against known Heun/RK4 baselines,
- norm-drift checks.

### 5.2 Cross-backend checks

For each explicitly supported FDM/FEM realization, compare:

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

(limitations)=
## 7. Known limits and deferred work

- no geometric tangent-plane integrators in this note,
- no implicit or IMEX methods,
- renormalized explicit RK may reduce formal order in extreme cases,
- explicit adaptive methods may still struggle on very stiff exchange-dominated meshes,
- demag cost can dominate high-stage methods.

(scientific-bibliography)=
## 8. References

Primary methods:

1. Bogacki and Shampine (1989), *A 3(2) pair of Runge-Kutta formulas*, DOI: [10.1016/0893-9659(89)90079-7](https://doi.org/10.1016/0893-9659(89)90079-7).
2. Dormand and Prince (1980), *A family of embedded Runge-Kutta formulae*, DOI: [10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).

Internal references:

- `docs/physics/0200-llg-exchange-reference-engine.md`
- `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`

(round-trip-and-failure-semantics)=
## 9. Canonical time-policy reconciliation

Contracts: `LLG-TD-POLICY-V1`, `LLG-TD-ATTEMPT-V1`,
`LLG-TD-FIRST-DT-V1`, `LLG-TD-MAX-ERR-V1`, `LLG-TD-ATOMIC-V1`.

Requested intent: the alias is accepted at Python authoring, then normalized
before `ProblemIR`; an omitted initial step remains omitted. Resolved execution:
the planner selects a legal family/lane and preserves the resolved time policy.
Validation errors: unknown method, nonpositive timestep, zero total tolerance,
or fixed/adaptive overlap are rejected. Unsupported combinations: public
multilayer adaptive requests, SSPRK3 and RK56 tokens do not become legal through
the alias; forced GPU must never silently execute on CPU.

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

(implementation-mapping)=
## 10. Implementation and evidence mapping

The source index below maps current executable owners separately from the
historical research proposal. FDM CPU uses reusable Rust workspaces; FDM GPU
uses native CUDA SoA stages and device reductions. These are not one shared
hot loop. FEM ownership remains MFEM/hypre/libCEED through notes 0490/0960.
The alias changes no tableau, controller, Hamiltonian, requested device,
precision, stop criterion, clock, binary field carrier or artifact schema.

No runtime/device or scientific-order test was executed while adding this
source map. Python authoring tests and structural validation, when reported,
are source/contract evidence only. Qualification requires actual lane/device
identity, analytical order/error studies, norm/energy checks, transactional
rejection/floor handling and CPU/GPU parity for the requested workload.

(source-code-index)=
## 11. Source-code index

| Path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/dynamics.py | class LLG | Canonical alias validation and Python model serialization. |
| packages/fullmag-py/src/fullmag/model/dynamics.py | class AdaptiveTimestep | Actual parameter defaults, validation and adaptive IR. |
| packages/fullmag-py/src/fullmag/model/dynamics.py | class FieldRefreshPolicy | Optional field-refresh controls. |
| packages/fullmag-py/src/fullmag/model/dynamics.py | _from_max_error | Absolute max_err tolerance-mode normalization. |
| packages/fullmag-py/src/fullmag/world.py | class StudyBuilder | StudyBuilder.solver convenience policy authoring (delegates to module solver). |
| packages/fullmag-py/src/fullmag/world.py | _build_relax_llg_dynamics | Relaxation integrator and separate clock lowering. |
| crates/fullmag-ir/src/execution.rs | IntegratorChoice | Canonical FDM method tokens. |
| crates/fullmag-ir/src/execution.rs | FdmProjectionPolicyIR | Resolved unit-sphere stage policy. |
| crates/fullmag-ir/src/study.rs | AdaptiveTimeStepIR | Typed adaptive time policy. |
| crates/fullmag-plan/src/fdm.rs | plan_fdm | Single-grid FDM execution resolution. |
| crates/fullmag-plan/src/fdm.rs | plan_fdm_multilayer | Multilayer method/adaptive legality. |
| crates/fullmag-runner/src/fdm/mod.rs | reject_adaptive_multilayer_plan | Fail-closed runtime admission, separate BB policy. |
| crates/fullmag-engine/src/fdm/cpu/fields.rs | llg_rhs_from_field | Cell LLG field right-hand side. |
| crates/fullmag-engine/src/fdm/cpu/integrators.rs | rk23_step_buf | CPU projected Bogacki-Shampine stages. |
| crates/fullmag-engine/src/fdm/cpu/integrators.rs | rk4_step_buf | CPU RK4 stages. |
| crates/fullmag-engine/src/fdm/cpu/integrators.rs | rk45_step_buf | CPU Dormand-Prince stages and FSAL. |
| crates/fullmag-engine/src/fdm/cpu/integrators.rs | max_error_norm_buf | Actual CPU embedded-error reduction. |
| backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu | launch_rk23_step_fp64 | Native CUDA FP64 single-grid RK23 realization. |
| backends/fdm/gpu/cuda/integrators/multilayer_explicit_rk.cu | launch_multilayer_rk23_step_fp64 | Fixed staged CUDA FP64 RK23 realization. |
| packages/fullmag-py/tests/test_rk32_alias.py | class Rk32AliasTests | Executable runtime-independent normalization and mutual-exclusion tests. |
| docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md | DOC-ANCHOR:fdm-rk-research-proposals | Historical proposed controller/RK families, not executable support evidence. |
