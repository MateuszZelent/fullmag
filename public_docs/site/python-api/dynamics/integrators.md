---
title: Integrators
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-integrators)=
# Time Integrator Selection (`LLG.integrator`)

(python-api-dynamics-integrators-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and overview

`LLG.integrator` (and `study.solver(integrator=...)`) selects the numerical time-integration scheme used to advance the semi-discrete Landau–Lifshitz–Gilbert (LLG) equation across time-evolution and overdamped relaxation stages. Fullmag distinguishes fixed-step schemes (`heun`, `rk4`, `abm3`, `coupled_imex_ark2`), embedded adaptive Runge–Kutta pairs (`rk23`, `rk45`), and the planner-resolved `"auto"` mode.

(python-api-dynamics-integrators-governing-equations)=
<!-- (governing-equations)= -->
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
<!-- (symbols-and-si-units)= -->
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
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **Alias normalization**: `"euler"` normalizes to `"heun"` (two-stage second-order predictor–corrector) and `"dopri5"` normalizes to `"rk45"` (Dormand–Prince 5(4)).
- **Fixed vs. adaptive exclusivity**: Fixed-step integrators (`heun`, `rk4`, `abm3`, `coupled_imex_ark2`) require `fixed_timestep` and reject `adaptive_timestep`; adaptive pairs (`rk23`, `rk45`) reject `fixed_timestep`.
- **Provenance preservation**: `"auto"` is preserved verbatim in `ProblemIR` (`requested intent`) and resolved by the planner to `"rk45"` (or the appropriate lane default) in the execution plan and receipt (`resolved execution`).

(python-api-dynamics-integrators-python-api)=
<!-- (python-api)= -->
## 5. Python API and parameter contract

### Constructor signature

```text
fm.LLG(
    *,
    gamma: float = 2.211e5,
    integrator: str = "auto",
    fixed_timestep: float | None = None,
    adaptive_timestep: AdaptiveTimestep | None = None,
    field_refresh: FieldRefreshPolicy | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LLG.integrator` | `str` | `"auto"` | $1$ | One of `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` | Time integration scheme | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.integrator` |
| `LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive | Gyromagnetic ratio | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.gyromagnetic_ratio` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | Positive; exclusive with adaptive step | Fixed step size | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | Adaptive integrator required | Embedded error control | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.adaptive_timestep` |

### Executable Python example

```python
# %%
import fullmag as fm

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

# Compare Dormand-Prince RK45 and fixed-step ABM3 configurations
study = fm.study(world, target="fdm", device="cpu", precision="fp64")
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, rtol=1e-4, dt_min=1e-15, dt_max=2e-12),
)
study.stages.add_time(name="rk45_run", duration=0.1e-9, By=5e-3, save_m_every=50e-12)

study_abm3 = fm.study(world, target="fdm", device="cpu", precision="fp64")
study_abm3.solver(integrator="abm3", fixed_timestep=5e-14)
study_abm3.stages.add_time(name="abm3_run", duration=0.1e-9, By=5e-3, save_m_every=50e-12)

assert study.to_problem_ir()["study"]["dynamics"]["integrator"] == "rk45"
assert study_abm3.to_problem_ir()["study"]["dynamics"]["integrator"] == "abm3"
```

(python-api-dynamics-integrators-problem-ir)=
<!-- (problem-ir)= -->
## 6. `ProblemIR` and canonical script representation

```json
{
  "dynamics": {
    "equation": "llg",
    "gyromagnetic_ratio": 221100.0,
    "integrator": "abm3",
    "fixed_timestep": 5e-14,
    "adaptive_timestep": null,
    "field_refresh": null
  }
}
```

(python-api-dynamics-integrators-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `ProblemIR` stores the canonicalized `integrator` string (`requested intent`), while the execution plan and receipt record the concrete backend stepper (`resolved execution`).
- **Validation errors**: Unknown integrator strings or mismatched `fixed_timestep` / `adaptive_timestep` pairings raise `ValueError` validation errors in Python.
- **Unsupported combinations**: Requesting `abm3` or `coupled_imex_ark2` on `target="fem"` is rejected as an unsupported combination by the planner.

(python-api-dynamics-integrators-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

- **FEM CPU**: `context_step_explicit_rk_mfem` (`heun`, `rk4`, `rk23`, `rk45`).
- **FEM GPU**: `gpu_rk_device_resident_step` (`heun`, `rk4`, `rk23`, `rk45`).
- **FDM CPU**: `heun`, `rk4`, `rk23`, `rk45`, `abm3` (`abm3_step_soa_state_buf`), and `coupled_imex_ark2`.
- **FDM GPU**: CUDA `heun`, `rk4`, `rk23`, `rk45`, and `coupled_imex_ark2`.

(python-api-dynamics-integrators-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Status | Supported integrators |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `auto` |
| FEM | GPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `auto` |
| FDM | CPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` |
| FDM | GPU | `documented` | `heun`, `rk4`, `rk23`, `rk45`, `coupled_imex_ark2`, `auto` |

(python-api-dynamics-integrators-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `backends/fem/tests/rk_explicit_contract.cpp`.

(python-api-dynamics-integrators-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- `abm3` requires uniform $\Delta t$ across steps; changing external stage fields discontinuously across stage boundaries resets the multistep history unless resumed from a matching `FdmCpuSolverCheckpointV1`.

(python-api-dynamics-integrators-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. J. R. Dormand and P. J. Prince, *A family of embedded Runge–Kutta formulae*, J. Comput. Appl. Math. **6**, 19–26 (1980).
2. P. Bogacki and L. F. Shampine, *A 3(2) pair of Runge–Kutta formulas*, Appl. Math. Lett. **2**, 321–325 (1989).

(python-api-dynamics-integrators-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | Integrator selection, validation, and dynamics IR lowering |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | [`context_step_explicit_rk_mfem`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | Native FEM CPU explicit RK step driver |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_step.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | [`gpu_rk_device_resident_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | Native FEM GPU device-resident RK step driver |
| FDM CPU Engine | [`crates/fullmag-engine/src/fdm/cpu/state.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | [`FdmCpuSolverCheckpointV1`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | FDM CPU `abm3` multistep checkpoint contract |
