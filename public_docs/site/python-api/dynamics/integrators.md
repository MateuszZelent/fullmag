---
title: Integrators
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-integrators)=
# Time Integrator Selection (`LLG.integrator`)

(python-api-dynamics-integrators-problem-statement)=
## 1. Physical problem and overview

`LLG.integrator` (and `study.solver(integrator=...)`) selects the numerical time-integration scheme used to advance the semi-discrete Landau–Lifshitz–Gilbert (LLG) equation across time-evolution and overdamped relaxation stages. Fullmag distinguishes fixed-step-only schemes (`heun`, `rk4`, `abm3`), adaptive-capable schemes (`rk23`, `rk45`, and `coupled_imex_ark2` for coupled transient M3 spin drift-diffusion), and the planner-resolved `"auto"` mode.

(python-api-dynamics-integrators-governing-equations)=
## 2. Governing equations

For an $S$-stage explicit Runge–Kutta scheme with Butcher tableau $(a_{j\ell}, b_j, \widetilde{b}_j, c_j)$, advancing active spin state $y_n = \{\mathbf{m}_i(t_n)\}_{i \in \mathcal{A}}$ by $\Delta t$ evaluates

```{math}
:label: eq-python-integrator-rk
Y_j = \mathcal{N}\!\left(y_n + \Delta t \sum_{\ell=1}^{j-1} a_{j\ell}\,K_\ell\right),
\qquad
K_j = F\!\left(t_n + c_j \Delta t,\, Y_j\right),
\qquad
y_{n+1} = \mathcal{N}\!\left(y_n + \Delta t \sum_{j=1}^{S} b_j\,K_j\right),
```

where $\mathcal{N}(\cdot)$ normalizes each active 3-vector onto $\mathbb{S}^2$. For the 3-step Adams–Bashforth–Moulton predictor–corrector (`abm3` on FDM CPU), after a three-step `rk4` bootstrap at fixed step $\Delta t$, the predictor–corrector update is

```{math}
:label: eq-python-integrator-abm3
y_{n+1}^{(p)} = \mathcal{N}\!\left(y_n + \frac{\Delta t}{12}\left(23 F_n - 16 F_{n-1} + 5 F_{n-2}\right)\right),
\qquad
y_{n+1} = \mathcal{N}\!\left(y_n + \frac{\Delta t}{12}\left(5 F(t_{n+1}, y_{n+1}^{(p)}) + 8 F_n - F_{n-1}\right)\right).
```

(python-api-dynamics-integrators-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $y_n$ | Accepted normalized magnetization state at step $n$ | $1$ |
| $Y_j$ | Normalized stage state at Runge–Kutta stage $j$ | $1$ |
| $K_j$ | Stage LLG right-hand side derivative | $\mathrm{s^{-1}}$ |
| $F_n$ | Stored step LLG right-hand side derivative at $t_n$ | $\mathrm{s^{-1}}$ |
| $\Delta t$ | Time step size | $\mathrm{s}$ |
| $a_{j\ell}$ | Runge–Kutta stage coupling coefficient | $1$ |
| $b_j$ | High-order Runge–Kutta output weight | $1$ |
| $c_j$ | Runge–Kutta stage abscissa | $1$ |
| $t_n$ | Accepted step start time | $\mathrm{s}$ |

(python-api-dynamics-integrators-assumptions-and-validity)=
## 4. Assumptions and limits of validity

- **Alias normalization**: `"dp54"` normalizes to `"rk45"` (Dormand–Prince 5(4)), and `"bs23"` or `"rk32"` normalizes to `"rk23"` (Bogacki–Shampine 3(2)). Unrecognized names such as `"euler"` or `"dopri5"` raise `ValueError`.
- **Fixed vs. adaptive stepping**: `fixed_timestep` and `adaptive_timestep` are mutually exclusive. Fixed-step-only integrators (`heun`, `rk4`, `abm3`) reject `adaptive_timestep`, whereas `ADAPTIVE_INTEGRATORS = {"rk23", "rk45", "coupled_imex_ark2"}` accept `adaptive_timestep` (embedded RK error control for `rk23`/`rk45`; step-doubling ARS(2,3,2) error control for `coupled_imex_ark2`).
- **Provenance preservation**: `"auto"` is preserved verbatim in `ProblemIR` (`requested intent`) and resolved by the planner to a concrete backend stepper in the execution plan and receipt (`resolved execution`).

(python-api-dynamics-integrators-python-api)=
## 5. Python API and parameter contract

### Constructor signature

```text
fm.LLG(
    gamma: float = 221100.0,
    integrator: str = "auto",
    fixed_timestep: float | None = None,
    adaptive_timestep: AdaptiveTimestep | None = None,
    field_refresh: FieldRefreshPolicy | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LLG.integrator` | `str` | `"auto"` | $1$ | One of `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` (aliases: `dp54`, `bs23`, `rk32`) | Time integration scheme | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.integrator` |
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive finite | Gyromagnetic ratio | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.gyromagnetic_ratio` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | Positive finite; mutually exclusive with `adaptive_timestep` | Fixed step size | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | Adaptive integrator (`rk23`, `rk45`, `coupled_imex_ark2`, or `auto`) required | Embedded RK or step-doubling error control | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.adaptive_timestep` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | Optional `FieldRefreshPolicy` instance | Demagnetization refresh cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.field_refresh` |

### Executable Python example

```python
# %% Compare Dormand-Prince RK45 and fixed-step ABM3 dynamics contracts
import fullmag as fm

nm = 1.0e-9

rk45_dynamics = fm.LLG(
    integrator="dp54",  # normalizes to "rk45"
    adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, rtol=1e-4, dt_min=1e-15, dt_max=2e-12),
)
abm3_dynamics = fm.LLG(integrator="abm3", fixed_timestep=5.0e-14)
assert rk45_dynamics.integrator == "rk45"
assert abm3_dynamics.to_ir()["kind"] == "llg"
assert abm3_dynamics.to_ir()["integrator"] == "abm3"

study = fm.study("integrator_selection_example")
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
    integrator=rk45_dynamics.integrator,
    adaptive_timestep=rk45_dynamics.adaptive_timestep,
)
study.stages.add_run(until=0.1e-9, stage_id="rk45_run").autosave(
    fm.StageAutosave(fields=[fm.FieldAutosave("m", every=50.0e-12)])
)
```

(python-api-dynamics-integrators-problem-ir)=
## 6. `ProblemIR` and canonical script representation

```json
{
  "kind": "llg",
  "gyromagnetic_ratio": 221100.0,
  "integrator": "abm3",
  "fixed_timestep": 5e-14
}
```

(python-api-dynamics-integrators-round-trip-and-failure-semantics)=
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `ProblemIR` stores the canonicalized `integrator` string (`requested intent`), while the execution plan and receipt record the concrete backend stepper (`resolved execution`).
- **Validation errors**: Unknown integrator strings, supplying both `fixed_timestep` and `adaptive_timestep`, or attaching `adaptive_timestep` to `heun`/`rk4`/`abm3` raise `ValueError` validation errors in Python.
- **Unsupported combinations**: Requesting `abm3` or `coupled_imex_ark2` on `target="fem"`, or requesting `coupled_imex_ark2` outside a qualified transient M3 spin drift-diffusion study, is rejected as an unsupported combination by the planner.

(python-api-dynamics-integrators-discrete-realization)=
## 8. Discrete realization and numerical operators

- **FEM CPU**: `context_step_explicit_rk_mfem` (`heun`, `rk4`, `rk23`, `rk45`).
- **FEM GPU**: `gpu_rk_device_resident_step` (`heun`, `rk4`, `rk23`, `rk45`), including FSAL `k0` reuse for Heun/RK4 and a two-step linear potential predictor on Krylov lanes; see {ref}`numerical-methods-performance-fem-gpu-demag`.
- **FDM CPU**: `heun`, `rk4`, `rk23`, `rk45`, `abm3` (`abm3_step_soa_state_buf`), and `coupled_imex_ark2`.
- **FDM GPU**: CUDA `heun`, `rk4`, `rk23`, `rk45` (with FSAL and fused FP64 spin torques), and `coupled_imex_ark2`; see {ref}`numerical-methods-performance-fdm-core`.

(python-api-dynamics-integrators-implementation-mapping)=
## 9. Backend and device implementation mapping

| Solver | Device | Status | Supported integrators |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `auto` |
| FEM | GPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `auto` |
| FDM | CPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` |
| FDM | GPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `coupled_imex_ark2`, `auto` |

(python-api-dynamics-integrators-validation)=
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `backends/fem/tests/rk_explicit_contract.cpp`.

(python-api-dynamics-integrators-limitations)=
## 11. Known limitations and operational constraints

- `abm3` requires uniform $\Delta t$ across steps; changing external stage fields discontinuously across stage boundaries resets the multistep history unless resumed from a matching `FdmCpuSolverCheckpointV1`.
- `coupled_imex_ark2` is an ARS(2,3,2) IMEX scheme designed specifically for coupled transient M3 spin drift-diffusion problems and is not a general-purpose FEM integrator.

(python-api-dynamics-integrators-scientific-bibliography)=
## 12. Scientific bibliography

1. J. R. Dormand and P. J. Prince, *A family of embedded Runge–Kutta formulae*, J. Comput. Appl. Math. **6**, 19–26 (1980).
2. P. Bogacki and L. F. Shampine, *A 3(2) pair of Runge–Kutta formulas*, Appl. Math. Lett. **2**, 321–325 (1989).

(python-api-dynamics-integrators-source-code-index)=
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | Integrator selection, validation, and dynamics IR lowering |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | [`context_step_explicit_rk_mfem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | Native FEM CPU explicit RK step driver |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_step.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | [`gpu_rk_device_resident_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | Native FEM GPU device-resident RK step driver |
| FDM CPU Engine | [`crates/fullmag-engine/src/fdm/cpu/state.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | [`FdmCpuSolverCheckpointV1`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | FDM CPU `abm3` multistep checkpoint contract |
