---
title: Time Evolution
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-time-evolution)=
# `TimeEvolution` Study and `add_run` Stage Contract

(python-api-studies-time-evolution-problem-statement)=
## 1. Physical problem and overview

`fm.TimeEvolution` (and the stage-workflow builder `study.stages.add_run(until=..., stage_id=...)`, plus live helpers `fm.run(...)` and `fm.run_while(...)` / `fm.RunWhile`) defines a physical time-domain integration study or stage that evolves the magnetization field $\mathbf{m}(\mathbf{x}, t)$ over a finite time interval $[t_0, t_0 + T]$ under the Landau–Lifshitz–Gilbert (LLG) equation with precession enabled ($s_{\mathrm{prec}} = 1$). It owns the `LLG` dynamics policy, field/scalar output schedules (`outputs`), optional tabular autosave (`table_autosave`), and stage-applicable `FrozenSpins` constraints.

(python-api-studies-time-evolution-governing-equations)=
## 2. Governing equations

Over a time-evolution stage of duration $T = t_{\mathrm{end}} - t_0 > 0$, each active magnetic degree of freedom $i \in \mathcal{A}$ ($M_{s,i} > 0$) integrates

```{math}
:label: eq-time-evolution-ode
\frac{\mathrm{d}\mathbf{m}_i}{\mathrm{d}t}
=
-\frac{\gamma_0}{1 + \alpha_i^2}
\left[
\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)
+
\alpha_i\,\mathbf{m}_i \times \left(\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)\right)
\right]
+
\boldsymbol{\tau}_{\mathrm{direct},i}(\mathbf{m}, t),
\qquad
t \in [t_0, t_0 + T],
```

subject to $\|\mathbf{m}_i(t)\|_2 = 1$ and $\dot{\mathbf{m}}_j(t) = \mathbf{0}$ on any degree of freedom $j$ belonging to an active `FrozenSpins` constraint set.

(python-api-studies-time-evolution-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{m}_i$ | Reduced magnetization unit vector at active node/cell $i$ | $1$ |
| $\mathbf{H}_{\mathrm{eff},i}$ | Total effective magnetic field at node/cell $i$ | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | Reduced gyromagnetic ratio (`gamma`) | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha_i$ | Dimensionless Gilbert damping parameter | $1$ |
| $\boldsymbol{\tau}_{\mathrm{direct},i}$ | Direct current-induced spin-torque rate | $\mathrm{s^{-1}}$ |
| $t_0$ | Stage initial physical time | $\mathrm{s}$ |
| $T$ | Stage physical duration (`until`) | $\mathrm{s}$ |
| $t$ | Physical simulation time | $\mathrm{s}$ |

(python-api-studies-time-evolution-assumptions-and-validity)=
## 4. Assumptions and limits of validity

- **Full precessional dynamics**: Unlike `Relaxation(algorithm="llg_overdamped")`, `TimeEvolution` always retains the conservative precessional torque $-\gamma_0(1+\alpha^2)^{-1}\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}$.
- **Output horizon requirement**: Standalone `TimeEvolution` studies accept explicit field/scalar/snapshot `outputs` and optional `table_autosave`; in stage workflows (`study.stages.add_run(until=...)`), the explicit `until` horizon sets $T > 0$ and `.autosave(fm.StageAutosave(...))` configures stage-scoped table and field persistence.

(python-api-studies-time-evolution-python-api)=
## 5. Python API and parameter contract

### Constructor and stage-builder signatures

```text
fm.TimeEvolution(
    dynamics: LLG,
    outputs: Sequence[TimeOutputSpec],
    constraints: Sequence[FrozenSpins] = (),
    table_autosave: TableAutosave | None = None,
)

study.stages.add_run(
    until: float | None = None,
    *,
    stage_id: str | None = None,
) -> RunStageBuilder  # chain .autosave(StageAutosave(...))
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `TimeEvolution.dynamics` | `LLG` | required | mixed | typed dynamics policy | time-domain equation and integrator | planner-dependent | `study.dynamics` |
| `TimeEvolution.outputs` | `Sequence[TimeOutputSpec]` | required | mixed | typed outputs; empty sequence legal | requested field/scalar/snapshot sampling | planner-dependent | `study.sampling.outputs` |
| `TimeEvolution.constraints` | `Sequence[FrozenSpins]` | `()` | $1$ | typed frozen-spin constraints; references resolved at problem/planner boundary | stage-applicable magnetization constraints | capability-gated by target and lane | canonical magnetization constraints associated with the study |
| `TimeEvolution.table_autosave` | `TableAutosave \| None` | `None` | mixed | typed autosave policy | optional scalar-table sampling | planner/runtime-dependent | `study.sampling.table_autosave` |

### Executable Python example

```python
# %% Stage-first time evolution with adaptive RK45 and autosave
import fullmag as fm

nm = 1.0e-9

study = fm.study("time_evolution_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

strip = study.geometry(fm.Box(size=(100 * nm, 25 * nm, 5 * nm)), name="strip")
strip.Ms = 800.0e3
strip.Aex = 13.0e-12
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.05, 0.0)

study.exchange()
study.demag()
study.b_ext(20.0e-3, 3.0e-3, 0.0)
study.solver(
    integrator="rk45",
    gamma=2.211e5,
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1e-6,
        rtol=1e-4,
        dt_initial=1e-13,
        dt_min=1e-15,
        dt_max=2e-12,
    ),
)
study.stages.add_run(until=0.5e-9, stage_id="rf_pulse").autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(t_sampl=10.0e-12),
        fields=[fm.FieldAutosave("m", every=50.0e-12)],
    )
)

te = fm.TimeEvolution(
    dynamics=fm.LLG(
        gamma=2.211e5,
        integrator="rk45",
        adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, rtol=1e-4, dt_initial=1e-13, dt_min=1e-15, dt_max=2e-12),
    ),
    outputs=[fm.SaveField("m", every=50.0e-12)],
    table_autosave=fm.TableAutosave(t_sampl=10.0e-12),
)
ir = te.to_ir()
assert ir["kind"] == "time_evolution"
assert ir["dynamics"]["integrator"] == "rk45"
```

(python-api-studies-time-evolution-problem-ir)=
## 6. `ProblemIR` and canonical script representation

```json
{
  "kind": "time_evolution",
  "dynamics": {
    "kind": "llg",
    "gyromagnetic_ratio": 221100.0,
    "integrator": "rk45",
    "fixed_timestep": null,
    "adaptive_timestep": {
      "tolerance_mode": "advanced",
      "atol": 1e-06,
      "rtol": 0.0001,
      "dt_initial": 1e-13,
      "dt_min": 1e-15,
      "safety": 0.9,
      "growth_limit": 2.0,
      "shrink_limit": 0.2,
      "dt_max": 2e-12
    }
  },
  "sampling": {
    "outputs": [
      {
        "kind": "field",
        "name": "m",
        "every_seconds": 5e-11
      }
    ],
    "table_autosave": {
      "sample_period_s": 1e-11,
      "quantities": ["step", "t", "mx", "my", "mz", "e_total", "max_torque"],
      "table_id": "default"
    }
  }
}
```

(python-api-studies-time-evolution-round-trip-and-failure-semantics)=
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `TimeEvolution` and `add_run` stages preserve the user's `dynamics`, `outputs`, `constraints`, and `table_autosave` in `ProblemIR` (`requested intent`) while recording resolved stepper decisions and sample counts in the execution receipt (`resolved execution`).
- **Validation errors**: Non-`LLG` dynamics, invalid `TimeOutputSpec` or `FrozenSpins` items, or non-positive stage `until` horizon raise immediate `TypeError` / `ValueError` validation errors in Python.
- **Unsupported combinations**: Combining `FrozenSpins` or coupled elastodynamics with an unqualified backend/integrator lane is rejected as an unsupported combination by the planner.

(python-api-studies-time-evolution-discrete-realization)=
## 8. Discrete realization and numerical operators

- **FEM CPU & GPU**: Advances nodal magnetization via `context_step_explicit_rk_mfem` (CPU) or `gpu_rk_device_resident_step` (GPU) and records scheduled field/scalar snapshots at accepted step boundaries. See {ref}`numerical-methods-performance-fem-gpu-demag` and {ref}`numerical-methods-performance-fem-gpu-kernels` for FEM GPU `cuDSS` demagnetization, RK FSAL `k0` reuse, and fused short-range kernels.
- **FDM CPU & GPU**: Advances Cartesian SoA/AoS magnetization via explicit RK, `abm3`, or `coupled_imex_ark2` in `crates/fullmag-runner/src/solvers/fdm/workflows/time_domain/`. See {ref}`numerical-methods-performance-fdm-core` for batched Hermitian cuFFT and FSAL stepping.

(python-api-studies-time-evolution-implementation-mapping)=
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM explicit RK time-domain loop and snapshot emission. |
| FEM | GPU | `documented` | Device-resident CUDA RK loop (`rk_step.cu`), `cuDSS` / AMG demag, and device observable reductions. |
| FDM | CPU | `documented` | Cartesian SoA time-domain workflow (`crates/fullmag-runner/src/solvers/fdm/workflows/time_domain/`). |
| FDM | GPU | `documented` | CUDA time-domain workflow, batched Hermitian cuFFT demagnetization, and fused FP64 RK45 spin torques. |

(python-api-studies-time-evolution-validation)=
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py`, `test_standard_problem_4_fem.py`, `test_standard_problem_5_fdm.py`, and `test_standard_problem_5_fem.py`.

(python-api-studies-time-evolution-limitations)=
## 11. Known limitations and operational constraints

- Snapshot and table sampling intervals are evaluated at accepted step boundaries; set `dt_max` at or below the finest sampling interval when exact uniform temporal spacing is required without interpolation.

(python-api-studies-time-evolution-scientific-bibliography)=
## 12. Scientific bibliography

1. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376 (1999).

## Control Room support

Status: Time-evolution stage authoring, live scalar time-series charts, and interactive stage re-execution are `partial`; custom stopping predicates (`fm.run_until`), low-level integrator hooks, and specialized stage closures remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Stage duration, timestep / integrator policy, & initial-state handoff | `Model Explorer -> Stages -> Add stage -> Run` (`RunStageSpec`, `StudyStagesSpec`) | `partial` | Commit stage draft and trigger stage compute (`scene_revision`-pinned) |
| Live magnetization, energy & torque traces | `Live Charts` (`LiveChartsModule`, `LiveChartControls`) | `inspection-only` | Binary FMTB stream + WebSocket `scalar.sample` follow window & CSV export |
| Per-stage texture overrides | `Model Explorer -> Stages -> <stage> -> Initial State / Textures` | `partial` | Staged draft mutation on `scene_revision` |
| Python-only constraints or programmatic callbacks | `Model Explorer -> Stages -> <stage>` | `Python-only` | Authored via Python script or live `fm.run()` / `fm.run_until()` |

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Control Room Run Stage Inspector and stage re-run transaction controls
:align: center
:width: 100%
```

```{image} /_static/images/ui/charts-live-time-series.png
:alt: Live Charts time-series view plotting magnetization components and energy during a time-evolution run
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/studies-and-stages`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/stages/RunStageSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/study/StudyStagesSpec.tsx`, and `apps/control-room/src/modules/live-charts/LiveChartsView.tsx`.

(python-api-studies-time-evolution-source-code-index)=
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L761) | [`class TimeEvolution`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L761) | Owns dynamics, outputs, frozen-spin constraints, autosave, and lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | Stage-workflow `.stages.add_run(...)` and `.solver(...)` authoring |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | [`context_step_explicit_rk_mfem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | Native FEM CPU explicit RK step execution |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_step.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | [`gpu_rk_device_resident_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | Native FEM GPU device-resident explicit RK step execution |
