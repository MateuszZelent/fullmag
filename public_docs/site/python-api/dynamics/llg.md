---
title: LLG
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-llg)=
# `LLG` Dynamics Contract

(python-api-dynamics-llg-problem-statement)=
## 1. Physical problem and overview

`fm.LLG` is the public Python DSL contract that parameterizes the Landau–Lifshitz–Gilbert (LLG) equation of motion for time-domain evolution and overdamped LLG relaxation (`algorithm="llg_overdamped"`). It binds the H-field gyromagnetic ratio $\gamma_0$, the requested time-integration scheme (`integrator`), the mutually exclusive fixed (`fixed_timestep`) or adaptive (`adaptive_timestep`) step-size controller, and the optional demagnetization refresh cadence (`field_refresh`).

In stage-first scripts, the same dynamics settings are configured on the active study through `study.solver(integrator=..., gamma=..., fix_dt=..., adaptive_timestep=..., demag_interval_s=...)`.

(python-api-dynamics-llg-governing-equations)=
## 2. Governing equations

On active magnetic degrees of freedom $i \in \mathcal{A}$ ($M_{s,i} > 0$), `fm.LLG` specifies the explicit normalized Landau–Lifshitz–Gilbert right-hand side:

```{math}
:label: eq-python-llg-rhs
\frac{\mathrm{d}\mathbf{m}_i}{\mathrm{d}t}
=
-\frac{\gamma_0}{1 + \alpha_i^2}
\left[
s_{\mathrm{prec}}\,\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)
+
\alpha_i\,\mathbf{m}_i \times \left(\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)\right)
\right]
+
\boldsymbol{\tau}_{\mathrm{direct},i}(\mathbf{m}, t),
\qquad
\|\mathbf{m}_i\|_2 = 1.
```

(python-api-dynamics-llg-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{m}_i$ | Reduced magnetization unit vector at active node/cell $i$ | $1$ |
| $\mathbf{H}_{\mathrm{eff},i}$ | Total effective magnetic field at node/cell $i$ | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | Reduced gyromagnetic ratio (`LLG.gamma`) | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha_i$ | Dimensionless Gilbert damping parameter (`alpha`) | $1$ |
| $s_{\mathrm{prec}}$ | Precession switch ($1$ in time evolution, $0$ in pure-damping relaxation) | $1$ |
| $\boldsymbol{\tau}_{\mathrm{direct},i}$ | Optional direct current-driven spin torque rate | $\mathrm{s^{-1}}$ |
| $t$ | Physical simulation time | $\mathrm{s}$ |

(python-api-dynamics-llg-assumptions-and-validity)=
## 4. Assumptions and limits of validity

- **H-field gyromagnetic convention**: `LLG.gamma` is expressed in $\mathrm{m\,A^{-1}\,s^{-1}}$ (default $2.211\times 10^5\,\mathrm{m\,A^{-1}\,s^{-1}} \approx \mu_0 |\gamma_e|$) so that $\gamma_0 \mathbf{H}_{\mathrm{eff}}$ has units of $\mathrm{s^{-1}}$.
- **Stepping exclusivity**: `fixed_timestep` and `adaptive_timestep` are mutually exclusive. Attaching `adaptive_timestep` requires an adaptive integrator (`rk23`, `rk45`, `coupled_imex_ark2`) or `"auto"`; attaching `adaptive_timestep` to `heun`, `rk4`, or `abm3` raises an immediate `ValueError`. Supplying `fixed_timestep` is permitted in Python for any supported integrator and validated by the planner against the selected backend lane.
- **Alias normalization**: Passing `"dp54"` normalizes to `"rk45"`, and passing `"bs23"` or `"rk32"` normalizes to `"rk23"`. Unrecognized names (such as `"euler"` or `"dopri5"`) raise `ValueError`.

(python-api-dynamics-llg-python-api)=
## 5. Python API and parameter contract

### Constructor and stage-builder signatures

```text
fm.LLG(
    gamma: float = 221100.0,
    integrator: str = "auto",
    fixed_timestep: float | None = None,
    adaptive_timestep: AdaptiveTimestep | None = None,
    field_refresh: FieldRefreshPolicy | None = None,
)

study.solver(
    *,
    fix_dt: float | None = None,
    dt_initial: float | None = None,
    dt_max: float | None = None,
    max_err: float | None = None,
    adaptive_timestep: AdaptiveTimestep | None = None,
    dt: float | None = None,
    max_error: float | None = None,
    dt_min: float | None = None,
    integrator: str | None = None,
    gamma: float | None = None,
    g: float | None = None,
    demag_interval_s: float | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive finite gyromagnetic ratio used by the H-field LLG convention. | Positive finite gyromagnetic ratio used by the H-field LLG convention. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `"auto"` | $1$ | Canonical supported integrator identifier (`heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto`) or alias (`dp54`, `bs23`, `rk32`). | Canonical supported integrator identifier or `auto`; planner and runtime legality are validated explicitly. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | Positive finite fixed step when supplied; mutually exclusive with `adaptive_timestep`. | Positive fixed step when supplied; mutually constrained with adaptive stepping. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | Optional adaptive-step contract; requires `rk23`, `rk45`, `coupled_imex_ark2`, or `auto`. | Optional adaptive-step contract. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.adaptive_timestep` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | Optional field-refresh policy. | Optional field-refresh policy. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.field_refresh` |

### Executable Python example

```python
# %% Configure LLG dynamics in a stage-first FDM study
import fullmag as fm

nm = 1.0e-9

dynamics = fm.LLG(
    gamma=2.211e5,
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1e-6,
        rtol=1e-4,
        dt_initial=1e-13,
        dt_min=1e-15,
        dt_max=2e-12,
    ),
)

study = fm.study("llg_dynamics_example")
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
    integrator=dynamics.integrator,
    gamma=dynamics.gamma,
    adaptive_timestep=dynamics.adaptive_timestep,
)
study.stages.add_run(until=0.2e-9, stage_id="pulse").autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(t_sampl=10.0e-12),
        fields=[fm.FieldAutosave("m", every=50.0e-12)],
    )
)

ir = dynamics.to_ir()
assert ir["kind"] == "llg"
assert ir["integrator"] == "rk45"
assert ir["adaptive_timestep"]["tolerance_mode"] == "advanced"
```

(python-api-dynamics-llg-problem-ir)=
## 6. `ProblemIR` and canonical script representation

`LLG.to_ir()` emits `{"kind": "llg", ...}`, omitting `adaptive_timestep` and `field_refresh` when unset:

```json
{
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
}
```

(python-api-dynamics-llg-round-trip-and-failure-semantics)=
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `LLG.to_ir()` preserves `integrator="auto"` in `ProblemIR` (`requested intent`) while the planner and execution receipt record the concrete resolved integrator and device lane (`resolved execution`).
- **Validation errors**: Non-positive or non-finite `gamma`, unknown `integrator` names, supplying both `fixed_timestep` and `adaptive_timestep`, or attaching `adaptive_timestep` to `heun`/`rk4`/`abm3` raise immediate `ValueError` validation errors.
- **Unsupported combinations**: Requesting FDM-only integrators (`abm3`, `coupled_imex_ark2`) on `target="fem"` or incompatible stepping combinations for a lane is rejected as an unsupported combination by the planner without silent fallback.

(python-api-dynamics-llg-discrete-realization)=
## 8. Discrete realization and numerical operators

- **FEM CPU & GPU**: Evaluates nodewise LLG torques (`llg_rhs_aos` on CPU and `fullmag_cuda_llg_rhs_fused` on GPU) and advances the state via explicit Runge–Kutta tableaus (`heun`, `rk4`, `rk23`, `rk45`). On FEM GPU, single-launch fused effective-field accumulation and RK FSAL `k0` reuse accelerate time stepping; see {ref}`numerical-methods-performance-fem-gpu-demag` and {ref}`numerical-methods-performance-fem-gpu-kernels`.
- **FDM CPU & GPU**: Evaluates cell-centered SoA/AoS LLG torques across active magnetic cells and advances via explicit RK, `abm3` multistep, or `coupled_imex_ark2` (for transient M3 spin drift-diffusion). On FDM GPU, fused FP64 RK45 spin-torque kernels and batched Hermitian cuFFT demagnetization accelerate evolution; see {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fdm-transport`.

(python-api-dynamics-llg-implementation-mapping)=
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM `llg_rhs_aos` and `context_step_explicit_rk_mfem`. |
| FEM | GPU | `documented` | CUDA `fullmag_cuda_llg_rhs_fused` and `gpu_rk_device_resident_step`. |
| FDM | CPU | `documented` | Reference Cartesian SoA LLG and RK/ABM3/IMEX steppers. |
| FDM | GPU | `documented` | CUDA LLG, fused FP64 RK45 spin torques, and adaptive reduction kernels. |

(python-api-dynamics-llg-validation)=
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `packages/fullmag-py/tests/test_problem_ir.py`.

(python-api-dynamics-llg-limitations)=
## 11. Known limitations and operational constraints

- Direct energy minimizers (`projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit`) do not use an `LLG` dynamics payload; passing `dynamics` to a direct-minimizer `Relaxation` study raises a `ValueError`.

(python-api-dynamics-llg-scientific-bibliography)=
## 12. Scientific bibliography

1. T. L. Gilbert, *A phenomenological theory of damping in ferromagnetic materials*, IEEE Trans. Magn. **40**, 3443 (2004).

(python-api-dynamics-llg-source-code-index)=
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | Owns the documented public API, validation, and lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | Stage-workflow `.solver(...)` configuration and `ProblemIR` compilation |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/llg_rhs.cpp#L31) | [`llg_rhs_aos`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/llg_rhs.cpp#L31) | Native FEM CPU nodewise LLG right-hand-side evaluation |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu#L84) | [`fullmag_cuda_llg_rhs_fused`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu#L84) | Native FEM CUDA fused LLG right-hand-side kernel |
