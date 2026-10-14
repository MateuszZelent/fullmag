---
title: Time Evolution
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-time-evolution)=
# `TimeEvolution` Study and `add_time` Stage Contract

(python-api-studies-time-evolution-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and overview

`fm.TimeEvolution` (and the stage-workflow builder `study.stages.add_time(...)` / `world.time_stage(...)`) defines a physical time-domain integration study or stage that evolves the magnetization field $\mathbf{m}(\mathbf{x}, t)$ over a finite time interval $[t_0, t_0 + T]$ under the Landau–Lifshitz–Gilbert (LLG) equation with precession enabled ($s_{\mathrm{prec}} = 1$). It owns the `LLG` dynamics policy, field/scalar output schedules (`outputs`), optional tabular autosave (`table_autosave`), and stage-applicable `FrozenSpins` constraints.

(python-api-studies-time-evolution-governing-equations)=
<!-- (governing-equations)= -->
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
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{m}_i$ | Reduced magnetization unit vector at active node/cell $i$ | $1$ |
| $\mathbf{H}_{\mathrm{eff},i}$ | Total effective magnetic field at node/cell $i$ | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | Reduced gyromagnetic ratio (`gamma`) | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha_i$ | Dimensionless Gilbert damping parameter | $1$ |
| $\boldsymbol{\tau}_{\mathrm{direct},i}$ | Direct current-induced spin-torque rate | $\mathrm{s^{-1}}$ |
| $t_0$ | Stage initial physical time | $\mathrm{s}$ |
| $T$ | Stage physical duration (`duration`) | $\mathrm{s}$ |
| $t$ | Physical simulation time | $\mathrm{s}$ |

(python-api-studies-time-evolution-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **Full precessional dynamics**: Unlike `Relaxation(algorithm="llg_overdamped")`, `TimeEvolution` always retains the conservative precessional torque $-\gamma_0(1+\alpha^2)^{-1}\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}$.
- **Output horizon requirement**: Standalone `TimeEvolution` studies require either a non-empty `outputs` sequence with positive time horizon or a valid `table_autosave` schedule so that the integration interval is well-defined; in stage workflows (`study.stages.add_time(duration=...)`), the explicit `duration` parameter sets $T > 0$.

(python-api-studies-time-evolution-python-api)=
<!-- (python-api)= -->
## 5. Python API and parameter contract

### Constructor and stage-builder signatures

```text
fm.TimeEvolution(
    *,
    dynamics: LLG,
    outputs: Sequence[TimeOutputSpec],
    constraints: Sequence[FrozenSpins] = (),
    table_autosave: TableAutosave | None = None,
)

study.stages.add_time(
    *,
    name: str | None = None,
    duration: float,
    Bx: float | None = None,
    By: float | None = None,
    Bz: float | None = None,
    save_m_every: float | None = None,
    save_table_every: float | None = None,
    outputs: Sequence[TimeOutputSpec] = (),
    constraints: Sequence[FrozenSpins] = (),
)
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
# %%
import fullmag as fm

world = fm.World(
    dx=5e-9,
    dy=5e-9,
    dz=5e-9,
    nx=20,
    ny=5,
    nz=1,
    boundaries=fm.BoundaryConfig.open(method="fft"),
)
world.add_box(
    "strip",
    size=(100e-9, 25e-9, 5e-9),
    material=fm.Material.permalloy(Ms=8.0e5, Aex=1.3e-11, alpha=0.02),
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.05, 0.0)),
    demag=True,
)

study = fm.study(world, target="fdm", device="cpu", precision="fp64")
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
study.stages.add_time(
    name="rf_pulse",
    duration=0.5e-9,
    Bx=20e-3,
    By=3e-3,
    Bz=0.0,
    save_m_every=50e-12,
    save_table_every=10e-12,
)

ir = study.to_problem_ir()
assert ir["study"]["kind"] == "stage_workflow"
assert ir["study"]["stages"][0]["kind"] == "time"
assert ir["study"]["stages"][0]["duration"] == 0.5e-9
```

(python-api-studies-time-evolution-problem-ir)=
<!-- (problem-ir)= -->
## 6. `ProblemIR` and canonical script representation

```json
{
  "study": {
    "kind": "stage_workflow",
    "dynamics": {
      "equation": "llg",
      "gyromagnetic_ratio": 221100.0,
      "integrator": "rk45",
      "fixed_timestep": null,
      "adaptive_timestep": {
        "atol": 1e-06,
        "rtol": 0.0001,
        "dt_initial": 1e-13,
        "dt_min": 1e-15,
        "dt_max": 2e-12,
        "safety": 0.9,
        "growth_limit": 2.0,
        "shrink_limit": 0.2,
        "max_spin_rotation": null,
        "norm_tolerance": null
      },
      "field_refresh": null
    },
    "stages": [
      {
        "kind": "time",
        "name": "rf_pulse",
        "duration": 5e-10
      }
    ]
  }
}
```

(python-api-studies-time-evolution-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `TimeEvolution` and `add_time` stages preserve the user's `dynamics`, `outputs`, `constraints`, and `table_autosave` in `ProblemIR` (`requested intent`) while recording resolved stepper decisions and sample counts in the execution receipt (`resolved execution`).
- **Validation errors**: Non-`LLG` dynamics, invalid `TimeOutputSpec` or `FrozenSpins` items, or non-positive stage `duration` raise immediate `TypeError` / `ValueError` validation errors in Python.
- **Unsupported combinations**: Combining `FrozenSpins` or coupled elastodynamics with an unqualified backend/integrator lane is rejected as an unsupported combination by the planner.

(python-api-studies-time-evolution-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

- **FEM CPU & GPU**: Advances nodal magnetization via `context_step_explicit_rk_mfem` (CPU) or `gpu_rk_device_resident_step` (GPU) and records scheduled field/scalar snapshots at accepted step boundaries.
- **FDM CPU & GPU**: Advances Cartesian SoA/AoS magnetization via explicit RK, `abm3`, or `coupled_imex_ark2` in `crates/fullmag-runner/src/solvers/fdm/workflows/time_domain/`.

(python-api-studies-time-evolution-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM explicit RK time-domain loop and snapshot emission. |
| FEM | GPU | `documented` | Device-resident CUDA RK loop (`rk_step.cu`) and device observable reductions. |
| FDM | CPU | `documented` | Cartesian SoA time-domain workflow (`crates/fullmag-runner/src/solvers/fdm/workflows/time_domain/`). |
| FDM | GPU | `documented` | CUDA time-domain workflow and FFT demagnetization. |

(python-api-studies-time-evolution-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py`, `test_standard_problem_4_fem.py`, `test_standard_problem_5_fdm.py`, and `test_standard_problem_5_fem.py`.

(python-api-studies-time-evolution-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- Snapshot and table sampling intervals are evaluated at accepted step boundaries; set `dt_max` at or below the finest sampling interval when exact uniform temporal spacing is required without interpolation.

(python-api-studies-time-evolution-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376 (1999).

(python-api-studies-time-evolution-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L695) | [`class TimeEvolution`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L695) | Owns dynamics, outputs, frozen-spin constraints, autosave, and lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | Stage-workflow `.stages.add_time(...)` and `.solver(...)` authoring |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | [`context_step_explicit_rk_mfem`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | Native FEM CPU explicit RK step execution |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_step.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | [`gpu_rk_device_resident_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | Native FEM GPU device-resident explicit RK step execution |
