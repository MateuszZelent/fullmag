---
title: Field Refresh
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-field-refresh)=
# `FieldRefreshPolicy` Contract

(python-api-dynamics-field-refresh-problem-statement)=
## 1. Physical problem and overview

`fm.FieldRefreshPolicy` specifies an optional cadence $\Delta t_{\mathrm{demag}}$ (`demag_interval_s`) for refreshing the non-local demagnetization field $\mathbf{H}_{\mathrm{d}}$ during time-domain LLG integration. When `demag_interval_s=None` (the default), the demagnetization operator is evaluated at every Runge–Kutta stage. When a positive `demag_interval_s` is configured on a lane that supports split-cadence refresh, the demagnetization field is recomputed whenever the elapsed physical time since the last refresh satisfies $t - t_{\mathrm{last}} \ge \Delta t_{\mathrm{demag}}$.

In stage-first scripts, attach this cadence via `study.solver(demag_interval_s=...)` or pass `field_refresh=fm.FieldRefreshPolicy(...)` to `study.stages.add_relax(...)`.

(python-api-dynamics-field-refresh-governing-equations)=
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
## 4. Assumptions and limits of validity

- **Time-scale separation**: Holding $\mathbf{H}_{\mathrm{d}}$ frozen over $\Delta t_{\mathrm{demag}}$ is accurate only when $\Delta t_{\mathrm{demag}}$ is much smaller than the magnetostatic precession period $(\gamma_0 M_s)^{-1}$.
- **First-order splitting error**: Freezing $\mathbf{H}_{\mathrm{d}}$ across intermediate Runge–Kutta stages reduces the formal temporal order of accuracy for dipolar-dominated modes to $\mathcal{O}(\Delta t_{\mathrm{demag}})$ whenever $\Delta t_{\mathrm{demag}} > \Delta t$.

(python-api-dynamics-field-refresh-python-api)=
## 5. Python API and parameter contract

### Constructor signature

```text
fm.FieldRefreshPolicy(
    demag_interval_s: float | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FieldRefreshPolicy.demag_interval_s` | `float \| None` | `None` | $\mathrm{s}$ | Positive finite when set | Demag refresh cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `field_refresh.demag_interval_s` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | Valid `FieldRefreshPolicy` instance | Attach refresh cadence to `fm.LLG` dynamics (see {doc}`llg` for other `LLG` fields) | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.field_refresh` |

### Executable Python example

```python
# %% Configure demagnetization refresh cadence in a stage-first FDM study
import fullmag as fm

nm = 1.0e-9

refresh = fm.FieldRefreshPolicy(demag_interval_s=5.0e-13)
dynamics = fm.LLG(
    integrator="rk4",
    fixed_timestep=1.0e-13,
    field_refresh=refresh,
)
assert dynamics.to_ir()["field_refresh"]["demag_interval_s"] == 5.0e-13

study = fm.study("field_refresh_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

strip = study.geometry(fm.Box(size=(80 * nm, 20 * nm, 5 * nm)), name="strip")
strip.Ms = 800.0e3
strip.Aex = 13.0e-12
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.05, 0.0)

study.exchange()
study.demag()
study.b_ext(0.0, 5.0e-3, 0.0)
study.solver(
    integrator="rk4",
    fix_dt=1.0e-13,
    demag_interval_s=refresh.demag_interval_s,
)
study.stages.add_run(until=0.1e-9, stage_id="pulse").autosave(
    fm.StageAutosave(fields=[fm.FieldAutosave("m", every=50.0e-12)])
)
```

(python-api-dynamics-field-refresh-problem-ir)=
## 6. `ProblemIR` and canonical script representation

```json
{
  "kind": "llg",
  "gyromagnetic_ratio": 221100.0,
  "integrator": "rk4",
  "fixed_timestep": 1e-13,
  "field_refresh": {
    "demag_interval_s": 5e-13
  }
}
```

(python-api-dynamics-field-refresh-round-trip-and-failure-semantics)=
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `FieldRefreshPolicy` serializes into `study.dynamics.field_refresh` (`requested intent`) and is validated against the selected backend lane during planning (`resolved execution`).
- **Validation errors**: Non-positive or non-finite `demag_interval_s` values raise immediate `ValueError` validation errors in Python.
- **Unsupported combinations**: When a backend or strict qualification mode requires full stage-wise demagnetization evaluation, non-null `demag_interval_s` is rejected as an unsupported combination by the planner.

(python-api-dynamics-field-refresh-discrete-realization)=
## 8. Discrete realization and numerical operators

- **Default (`demag_interval_s=None`)**: Full stage-wise demagnetization evaluation at every RK stage (`evaluate_rk_stage_rhs` on FEM CPU, `rk_demag_dispatch.cu` on FEM GPU, and FFT/Poisson demag on FDM).
- **Interval-gated refresh**: Caches the most recent $\mathbf{H}_{\mathrm{d}}$ buffer until the accumulated step time reaches `demag_interval_s`.

(python-api-dynamics-field-refresh-implementation-mapping)=
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Validated by planner and stage-refresh policy in `dynamics.py`. |
| FEM | GPU | `documented` | Device RK demag dispatch (`rk_demag_dispatch.cu`) and final refresh (`rk_final_refresh.cu`). |
| FDM | CPU | `documented` | Reference FDM stage evaluation and refresh cadence. |
| FDM | GPU | `documented` | CUDA FFT demagnetization evaluation. |

(python-api-dynamics-field-refresh-validation)=
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `packages/fullmag-py/tests/test_problem_ir.py`.

(python-api-dynamics-field-refresh-limitations)=
## 11. Known limitations and operational constraints

- Using `demag_interval_s` disables FSAL derivative reuse across steps where a deferred demagnetization refresh occurs at the step boundary.

(python-api-dynamics-field-refresh-scientific-bibliography)=
## 12. Scientific bibliography

1. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376 (1999).

(python-api-dynamics-field-refresh-source-code-index)=
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L142) | [`class FieldRefreshPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L142) | Demagnetization refresh policy validation and IR lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | Attaches `FieldRefreshPolicy` to the `LLG` dynamics contract |
