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
<!-- (problem-statement)= -->
## 1. Physical problem and overview

`fm.LLG` is the public Python DSL contract that parameterizes the Landau–Lifshitz–Gilbert (LLG) equation of motion for time-domain evolution and overdamped LLG relaxation (`algorithm="llg_overdamped"`). It binds the H-field gyromagnetic ratio $\gamma_0$, the requested time-integration scheme (`integrator`), the mutually exclusive fixed (`fixed_timestep`) or embedded adaptive (`adaptive_timestep`) step-size controller, and the optional demagnetization refresh cadence (`field_refresh`).

(python-api-dynamics-llg-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

On active magnetic degrees of freedom $i \in \mathcal{A}$ ($M_{s,i} > 0$), `LLG` specifies the explicit normalized Landau–Lifshitz–Gilbert right-hand side:

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
<!-- (symbols-and-si-units)= -->
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
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **H-field gyromagnetic convention**: `LLG.gamma` is expressed in $\mathrm{m\,A^{-1}\,s^{-1}}$ (default $2.211\times 10^5\,\mathrm{m\,A^{-1}\,s^{-1}} \approx \mu_0 |\gamma_e|$) so that $\gamma_0 \mathbf{H}_{\mathrm{eff}}$ has units of $\mathrm{s^{-1}}$.
- **Stepping exclusivity**: Fixed-step integrators (`heun`, `rk4`, `abm3`, `coupled_imex_ark2`) require `fixed_timestep` and reject `adaptive_timestep`, whereas embedded adaptive pairs (`rk23`, `rk45`) reject `fixed_timestep`.
- **Alias normalization**: Passing `"euler"` normalizes to `"heun"`, and passing `"dopri5"` normalizes to `"rk45"`.

(python-api-dynamics-llg-python-api)=
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
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive finite gyromagnetic ratio used by the H-field LLG convention. | Positive finite gyromagnetic ratio used by the H-field LLG convention. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `"auto"` | $1$ | Canonical supported integrator identifier or `auto`; planner and runtime legality are validated explicitly. | Canonical supported integrator identifier or `auto`; planner and runtime legality are validated explicitly. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | Positive fixed step when supplied; mutually constrained with adaptive stepping. | Positive fixed step when supplied; mutually constrained with adaptive stepping. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | Optional adaptive-step contract. | Optional adaptive-step contract. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.adaptive_timestep` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | Optional field-refresh policy. | Optional field-refresh policy. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.field_refresh` |

### Executable Python example

```python
# %%
import fullmag as fm

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
    integrator=dynamics.integrator,
    gamma=dynamics.gamma,
    adaptive_timestep=dynamics.adaptive_timestep,
)
study.stages.add_time(name="pulse", duration=0.2e-9, By=5e-3, save_m_every=50e-12)

ir = study.to_problem_ir()
assert ir["study"]["dynamics"]["equation"] == "llg"
assert ir["study"]["dynamics"]["integrator"] == "rk45"
```

(python-api-dynamics-llg-problem-ir)=
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
    }
  }
}
```

(python-api-dynamics-llg-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `LLG.to_dict()` preserves `integrator="auto"` in `ProblemIR` (`requested intent`) while the planner and execution receipt record the concrete resolved integrator and device lane (`resolved execution`).
- **Validation errors**: Non-positive or non-finite `gamma`, unknown `integrator` names, or supplying both `fixed_timestep` and `adaptive_timestep` raise immediate `ValueError` validation errors.
- **Unsupported combinations**: Attaching `fixed_timestep` to `rk23`/`rk45`, attaching `adaptive_timestep` to `heun`/`rk4`/`abm3`/`coupled_imex_ark2`, or requesting FDM-only integrators (`abm3`, `coupled_imex_ark2`) on `target="fem"` is rejected as an unsupported combination.

(python-api-dynamics-llg-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

- **FEM CPU & GPU**: Evaluates nodewise LLG torques (`llg_rhs_aos` on CPU and `fullmag_cuda_llg_rhs_fused` on GPU) and advances the state via explicit Runge–Kutta tableaus (`heun`, `rk4`, `rk23`, `rk45`).
- **FDM CPU & GPU**: Evaluates cell-centered SoA/AoS LLG torques across active magnetic cells and advances via explicit RK, `abm3` multistep, or `coupled_imex_ark2`.

(python-api-dynamics-llg-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM `llg_rhs_aos` and `context_step_explicit_rk_mfem`. |
| FEM | GPU | `documented` | CUDA `fullmag_cuda_llg_rhs_fused` and `gpu_rk_device_resident_step`. |
| FDM | CPU | `documented` | Reference Cartesian SoA LLG and RK/ABM3/IMEX steppers. |
| FDM | GPU | `documented` | CUDA LLG and adaptive reduction kernels. |

(python-api-dynamics-llg-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `packages/fullmag-py/tests/test_problem_ir.py`.

(python-api-dynamics-llg-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- Direct energy minimizers (`projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit`) do not use an `LLG` dynamics payload; passing `dynamics` to a direct-minimizer `Relaxation` study raises a `ValueError`.

(python-api-dynamics-llg-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. T. L. Gilbert, *A phenomenological theory of damping in ferromagnetic materials*, IEEE Trans. Magn. **40**, 3443 (2004).

(python-api-dynamics-llg-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | Owns the documented public API, validation, and lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | Stage-workflow `.solver(...)` configuration and `ProblemIR` compilation |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/llg_rhs.cpp#L30) | [`llg_rhs_aos`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/llg_rhs.cpp#L30) | Native FEM CPU nodewise LLG right-hand-side evaluation |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu#L76) | [`fullmag_cuda_llg_rhs_fused`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu#L76) | Native FEM CUDA fused LLG right-hand-side kernel |
