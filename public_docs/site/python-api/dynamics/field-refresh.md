---
title: Field Refresh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-field-refresh)=
# `FieldRefreshPolicy` Contract

(python-api-dynamics-field-refresh-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and overview

`fm.FieldRefreshPolicy` specifies an optional cadence $\Delta t_{\mathrm{demag}}$ (`demag_interval_s`) for refreshing the non-local demagnetization field $\mathbf{H}_{\mathrm{d}}$ during time-domain LLG integration. When `demag_interval_s=None` (the default), the demagnetization operator is evaluated at every Runge–Kutta stage. When a positive `demag_interval_s` is configured on a lane that supports split-cadence refresh, the demagnetization field is recomputed whenever the elapsed physical time since the last refresh satisfies $t - t_{\mathrm{last}} \ge \Delta t_{\mathrm{demag}}$.

(python-api-dynamics-field-refresh-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

Splitting the total effective field into fast local/exchange contributions $\mathbf{H}_{\mathrm{fast}}(\mathbf{m}, t)$ and the non-local demagnetizing field $\mathbf{H}_{\mathrm{d}}(\mathbf{m})$ yields

```{math}
:label: eq-python-field-refresh
\mathbf{H}_{\mathrm{eff}}(\mathbf{m}, t)
=
\mathbf{H}_{\mathrm{fast}}(\mathbf{m}, t)
+
\mathbf{H}_{\mathrm{d}}\!\left(\mathbf{m}(t_{\mathrm{last}})\right),
\qquad
t - t_{\mathrm{last}} < \Delta t_{\mathrm{demag}}.
```

(python-api-dynamics-field-refresh-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{H}_{\mathrm{eff}}$ | Total effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{fast}}$ | Local and short-range effective field contributions | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{d}}$ | Demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\Delta t_{\mathrm{demag}}$ | Demagnetization refresh interval (`demag_interval_s`) | $\mathrm{s}$ |
| $t_{\mathrm{last}}$ | Physical time of the most recent demagnetization evaluation | $\mathrm{s}$ |
| $t$ | Current simulation time | $\mathrm{s}$ |

(python-api-dynamics-field-refresh-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **Time-scale separation**: Holding $\mathbf{H}_{\mathrm{d}}$ frozen over $\Delta t_{\mathrm{demag}}$ is accurate only when $\Delta t_{\mathrm{demag}}$ is much smaller than the magnetostatic precession period $(\gamma_0 M_s)^{-1}$.
- **First-order splitting error**: Freezing $\mathbf{H}_{\mathrm{d}}$ across intermediate Runge–Kutta stages reduces the formal temporal order of accuracy for dipolar-dominated modes to $\mathcal{O}(\Delta t_{\mathrm{demag}})$ whenever $\Delta t_{\mathrm{demag}} > \Delta t$.

(python-api-dynamics-field-refresh-python-api)=
<!-- (python-api)= -->
## 5. Python API and parameter contract

### Constructor signature

```text
fm.FieldRefreshPolicy(
    *,
    demag_interval_s: float | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FieldRefreshPolicy.demag_interval_s` | `float \| None` | `None` | $\mathrm{s}$ | Positive | Demag refresh cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `field_refresh.demag_interval_s` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | Valid policy | Attach refresh cadence to dynamics | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.field_refresh` |

### Executable Python example

```python
# %%
import fullmag as fm

refresh = fm.FieldRefreshPolicy(demag_interval_s=5e-13)

world = fm.World(
    dx=5e-9,
    dy=5e-9,
    dz=5e-9,
    nx=16,
    ny=4,
    nz=1,
    boundaries=fm.BoundaryConfig.open(method="fft"),
)
world.add_box(
    "strip",
    size=(80e-9, 20e-9, 5e-9),
    material=fm.Material.permalloy(Ms=8.0e5, Aex=1.3e-11, alpha=0.02),
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.05, 0.0)),
    demag=True,
)

study = fm.study(world, target="fdm", device="cpu", precision="fp64")
study.solver(
    integrator="rk4",
    fixed_timestep=1e-13,
    field_refresh=refresh,
)
study.stages.add_time(name="pulse", duration=0.1e-9, By=5e-3, save_m_every=50e-12)

ir = study.to_problem_ir()
assert ir["study"]["dynamics"]["field_refresh"]["demag_interval_s"] == 5e-13
```

(python-api-dynamics-field-refresh-problem-ir)=
<!-- (problem-ir)= -->
## 6. `ProblemIR` and canonical script representation

```json
{
  "dynamics": {
    "equation": "llg",
    "gyromagnetic_ratio": 221100.0,
    "integrator": "rk4",
    "fixed_timestep": 1e-13,
    "adaptive_timestep": null,
    "field_refresh": {
      "demag_interval_s": 5e-13
    }
  }
}
```

(python-api-dynamics-field-refresh-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `FieldRefreshPolicy` serializes into `study.dynamics.field_refresh` (`requested intent`) and is validated against the selected backend lane during planning (`resolved execution`).
- **Validation errors**: Non-positive or non-finite `demag_interval_s` values raise immediate `ValueError` validation errors in Python.
- **Unsupported combinations**: When a backend or strict qualification mode requires full stage-wise demagnetization evaluation, non-null `demag_interval_s` is rejected as an unsupported combination by the planner.

(python-api-dynamics-field-refresh-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

- **Default (`demag_interval_s=None`)**: Full stage-wise demagnetization evaluation at every RK stage (`evaluate_rk_stage_rhs` on FEM CPU, `rk_demag_dispatch.cu` on FEM GPU, and FFT/Poisson demag on FDM).
- **Interval-gated refresh**: Caches the most recent $\mathbf{H}_{\mathrm{d}}$ buffer until the accumulated step time reaches `demag_interval_s`.

(python-api-dynamics-field-refresh-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Validated by planner and stage-refresh policy in `dynamics.py`. |
| FEM | GPU | `documented` | Device RK demag dispatch (`rk_demag_dispatch.cu`) and final refresh (`rk_final_refresh.cu`). |
| FDM | CPU | `documented` | Reference FDM stage evaluation and refresh cadence. |
| FDM | GPU | `documented` | CUDA FFT demagnetization evaluation. |

(python-api-dynamics-field-refresh-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `packages/fullmag-py/tests/test_problem_ir.py`.

(python-api-dynamics-field-refresh-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- Using `demag_interval_s` disables FSAL derivative reuse across steps where a deferred demagnetization refresh occurs at the step boundary.

(python-api-dynamics-field-refresh-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376 (1999).

(python-api-dynamics-field-refresh-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L141) | [`class FieldRefreshPolicy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L141) | Demagnetization refresh policy validation and IR lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | Attaches `FieldRefreshPolicy` to the `LLG` dynamics contract |
