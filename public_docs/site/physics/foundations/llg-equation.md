---
title: Landau–Lifshitz–Gilbert equation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
source_of_truth: packages/fullmag-py/src/fullmag/model/dynamics.py and backends/fem/cpu/mfem/integrators/llg_rhs.cpp
---

(public-docs-physics-foundations-llg-equation)=
(foundation-llg-problem-statement)=
# Landau–Lifshitz–Gilbert (LLG) Equation

(physics-foundations-llg-equation-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and overview

The Landau–Lifshitz–Gilbert (LLG) equation is the foundational equation of motion for continuum micromagnetics in Fullmag. It governs the precessional and dissipative evolution of the reduced magnetization field $\mathbf{m}(\mathbf{x}, t)$ on the unit sphere $\|\mathbf{m}(\mathbf{x}, t)\|_2 = 1$ under the total effective magnetic field $\mathbf{H}_{\mathrm{eff}}(\mathbf{x}, t)$ and optional spin-torque contributions.

This document specifies:

1. the physical and mathematical formulation of the implicit Gilbert equation and the explicit Landau–Lifshitz–Gilbert ordinary differential equation solved by the runtime,
2. the H-field gyromagnetic convention $\gamma_0 > 0$, local Gilbert damping $\alpha(\mathbf{x}) \ge 0$, precession switch $s_{\mathrm{prec}} \in \{0, 1\}$, and direct torque extensions $\boldsymbol{\tau}_{\mathrm{direct}}$,
3. the discrete normalization invariant, conservative torque orthogonality, and energy dissipation rate,
4. the complete public Python DSL (`fm.LLG`, `fm.AdaptiveTimestep`, `fm.FieldRefreshPolicy`, and `study.solver(...)`), `ProblemIR` serialization, and verified source-code index across FEM/FDM CPU/GPU lanes.

(physics-foundations-llg-equation-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

Let $\Omega_m \subset \mathbb{R}^3$ denote the ferromagnetic support where $M_s(\mathbf{x}) > 0$. The dimensional magnetization is parameterized by the saturation magnetization $M_s$ and the dimensionless unit-vector field $\mathbf{m}$:

```{math}
:label: eq-llg-reduced-magnetization
\mathbf{M}(\mathbf{x}, t) = M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x}, t),
\qquad
\|\mathbf{m}(\mathbf{x}, t)\|_2 = 1.
```

In implicit Gilbert form with H-field gyromagnetic constant $\gamma_0 > 0$ and dimensionless Gilbert damping $\alpha \ge 0$, the local magnetization evolves according to

```{math}
:label: eq-gilbert-implicit
\frac{\partial \mathbf{m}}{\partial t}
=
-\gamma_0\,\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+
\alpha\,\mathbf{m} \times \frac{\partial \mathbf{m}}{\partial t}.
```

Taking the cross product of {eq}`eq-gilbert-implicit` with $\mathbf{m}$, using the vector triple product $\mathbf{m} \times (\mathbf{m} \times \mathbf{v}) = (\mathbf{m}\cdot\mathbf{v})\mathbf{m} - \|\mathbf{m}\|_2^2\mathbf{v}$, and enforcing $\mathbf{m}\cdot \partial_t \mathbf{m} = 0$ on the unit sphere yields the explicit Landau–Lifshitz–Gilbert right-hand side evaluated by Fullmag's time integrators:

```{math}
:label: eq-llg-explicit
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma_0}{1 + \alpha^2}
\left[
s_{\mathrm{prec}}\,\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+
\alpha\,\mathbf{m} \times \left(\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}\right)
\right]
+
\boldsymbol{\tau}_{\mathrm{direct}}(\mathbf{m}, \mathbf{x}, t).
```

Here $s_{\mathrm{prec}} = 1$ for physical time-domain integration and $s_{\mathrm{prec}} = 0$ when pure-damping overdamped relaxation is selected (`llg_overdamped` with precession disabled), and $\boldsymbol{\tau}_{\mathrm{direct}}$ collects active spin-transfer and spin–orbit torques (Slonczewski, Zhang–Li, and spin–orbit torque).

For any conservative micromagnetic free energy $E[\mathbf{m}]$, the deterministic effective field is the negative variational derivative with respect to $\mu_0 \mathbf{M}$:

```{math}
:label: eq-llg-effective-field
\mathbf{H}_{\mathrm{eff}}(\mathbf{x}, t)
=
-\frac{1}{\mu_0 M_s(\mathbf{x})}
\frac{\delta E[\mathbf{m}]}{\delta \mathbf{m}(\mathbf{x}, t)}.
```

Because every term on the right-hand side of {eq}`eq-llg-explicit` is constructed as $\mathbf{m} \times (\cdots)$, the continuous dynamics strictly preserves the sphere constraint:

```{math}
:label: eq-llg-norm-invariant
\frac{1}{2}\frac{\partial}{\partial t}\|\mathbf{m}(\mathbf{x}, t)\|_2^2
=
\mathbf{m}(\mathbf{x}, t)\cdot \frac{\partial \mathbf{m}(\mathbf{x}, t)}{\partial t}
=
0.
```

Under a stationary external field and zero direct current torque ($\boldsymbol{\tau}_{\mathrm{direct}} = \mathbf{0}$), the micromagnetic free energy decreases monotonically along solutions of {eq}`eq-llg-explicit`:

```{math}
:label: eq-llg-energy-dissipation
\frac{\mathrm{d}E}{\mathrm{d}t}
=
-\int_{\Omega_m} \mu_0 M_s(\mathbf{x})\,
\frac{\alpha(\mathbf{x})\,\gamma_0}{1 + \alpha(\mathbf{x})^2}
\left\|\mathbf{m}(\mathbf{x}, t) \times \mathbf{H}_{\mathrm{eff}}(\mathbf{x}, t)\right\|_2^2
\,\mathrm{d}V
\le 0.
```

(physics-foundations-llg-equation-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

| Symbol | Meaning | SI unit | Notes |
| --- | --- | --- | --- |
| $\mathbf{m}$ | Reduced magnetization vector | $1$ | Unit vector in magnetic cells/nodes, $\mathbf{0}$ in vacuum |
| $\mathbf{M}$ | Dimensional magnetization vector | $\mathrm{A\,m^{-1}}$ | $\mathbf{M} = M_s \mathbf{m}$ |
| $M_s$ | Saturation magnetization | $\mathrm{A\,m^{-1}}$ | Region-owned material property |
| $\mathbf{H}_{\mathrm{eff}}$ | Total effective magnetic field | $\mathrm{A\,m^{-1}}$ | Sum of active interaction fields |
| $\gamma_0$ | Reduced gyromagnetic ratio (`gamma`) | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Default $2.211\times 10^{5}\,\mathrm{m\,A^{-1}\,s^{-1}} \approx \mu_0 |\gamma_e|$ |
| $\alpha$ | Gilbert damping parameter | $1$ | Non-negative material scalar or spatial field |
| $s_{\mathrm{prec}}$ | Precession factor | $1$ | $1$ in physical time evolution; $0$ in pure-damping relaxation |
| $\boldsymbol{\tau}_{\mathrm{direct}}$ | Direct current-induced spin-torque rate | $\mathrm{s^{-1}}$ | Optional Slonczewski, Zhang–Li, and SOT contributions |
| $E$ | Total micromagnetic free energy | $\mathrm{J}$ | Volume integral of active energy densities |
| $\mu_0$ | Vacuum permeability | $\mathrm{N\,A^{-2}}$ | $4\pi \times 10^{-7}\,\mathrm{N\,A^{-2}}$ |
| $t$ | Physical simulation time | $\mathrm{s}$ | Independent time variable |

(physics-foundations-llg-equation-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **Constant local saturation magnitude**: The LLG equation assumes $\|\mathbf{M}(\mathbf{x}, t)\|_2 = M_s(\mathbf{x})$ at temperatures well below the Curie temperature $T_C$. Longitudinal magnitude fluctuations require Landau–Lifshitz–Bloch (LLB) extensions not modeled by {eq}`eq-llg-explicit`.
- **Local isotropic damping**: The Gilbert parameter $\alpha(\mathbf{x}) \ge 0$ enters as a scalar factor per cell or node rather than a full anisotropic damping tensor.
- **Discrete sphere renormalization**: Explicit Runge–Kutta stages accumulate $\mathcal{O}(\Delta t^{p+1})$ radial drift off $\mathbb{S}^2$. Both CPU and GPU steppers re-normalize active spins to $\|\mathbf{m}_i\|_2 = 1$ at stage/step boundaries and enforce the optional `norm_tolerance` and `max_spin_rotation` guards during adaptive stepping (`LLG-TD-MAX-ERR-V1`).
- **Precession switch provenance**: Disabling precession ($s_{\mathrm{prec}} = 0$) accelerates convergence toward a local energy minimum in `llg_overdamped` relaxation but alters the transient trajectory and saddle-basin capture relative to physical damped precession ($s_{\mathrm{prec}} = 1$).

(physics-foundations-llg-equation-python-api)=
<!-- (python-api)= -->
## 5. Python API and parameter contract

### Canonical stage-workflow configuration (`study.solver(...)`)

```text
study.solver(
    *,
    integrator: str | None = None,
    gamma: float | None = None,
    fixed_timestep: float | None = None,
    adaptive_timestep: AdaptiveTimestep | None = None,
    field_refresh: FieldRefreshPolicy | None = None,
    dt_init: float | None = None,
    dt_min: float | None = None,
    dt_max: float | None = None,
    rtol: float | None = None,
    atol: float | None = None,
) -> StudyBuilder
```

### Explicit dynamics objects (`fm.LLG`, `fm.AdaptiveTimestep`, `fm.FieldRefreshPolicy`)

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

| Python parameter | Type | Default | SI unit | Validation / constraints | Physical / numerical meaning | Backend support | `ProblemIR` mapping |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | finite and $> 0$ | reduced gyromagnetic ratio $\gamma_0$ in H-field convention | FEM/FDM CPU/GPU | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `"auto"` | $1$ | `"heun"`, `"rk4"`, `"rk23"`, `"rk45"`, `"abm3"`, `"coupled_imex_ark2"`, `"auto"` (aliases `"euler"`, `"dopri5"` normalize) | time-integration scheme request | FEM: `heun`/`rk4`/`rk23`/`rk45`/`auto`; FDM adds `abm3` and `coupled_imex_ark2` | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | finite and $> 0$; mutually exclusive with `adaptive_timestep`; rejected on `rk23`/`rk45` | constant integration step $\Delta t$ for fixed-step methods | FEM/FDM CPU/GPU on fixed-step methods | `study.dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | valid `AdaptiveTimestep`; rejected on fixed-step methods (`heun`, `rk4`, `abm3`, `coupled_imex_ark2`) | embedded Runge–Kutta adaptive step-size controller contract | FEM/FDM CPU/GPU on `rk23`/`rk45`/`auto` | `study.dynamics.adaptive_timestep` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | valid `FieldRefreshPolicy` | optional demagnetization field refresh cadence | FEM/FDM CPU/GPU subject to planner checks | `study.dynamics.field_refresh` |
| `Material.alpha` | `float \| FieldSpec` | material-dependent | $1$ | finite and $\ge 0$ | dimensionless Gilbert damping $\alpha(\mathbf{x})$ | FEM/FDM CPU/GPU | `materials[].alpha` |
| `Material.Ms` | `float \| FieldSpec` | material-dependent | $\mathrm{A\,m^{-1}}$ | finite and $\ge 0$ | saturation magnetization $M_s(\mathbf{x})$ | FEM/FDM CPU/GPU | `materials[].ms` |

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
film = world.add_box(
    "permalloy",
    size=(100e-9, 25e-9, 5e-9),
    material=fm.Material.permalloy(Ms=8.0e5, Aex=1.3e-11, alpha=0.02),
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.1, 0.0)),
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
        dt_max=5e-12,
        safety=0.9,
        growth_limit=2.0,
        shrink_limit=0.2,
    ),
)
study.stages.add_time(
    name="precession",
    duration=0.5e-9,
    Bx=20e-3,
    By=2e-3,
    Bz=0.0,
    save_m_every=50e-12,
)

ir = study.to_problem_ir()
assert ir["study"]["kind"] == "stage_workflow"
assert ir["study"]["dynamics"]["integrator"] == "rk45"
assert ir["study"]["dynamics"]["gyromagnetic_ratio"] == 2.211e5
```

(physics-foundations-llg-equation-problem-ir)=
<!-- (problem-ir)= -->
## 6. `ProblemIR` and canonical script representation

The `LLG` policy serializes into `study.dynamics` inside `ProblemIR`:

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
        "dt_max": 5e-12,
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

(physics-foundations-llg-equation-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: Setting `integrator="auto"` preserves `"auto"` in `ProblemIR` (`requested intent`) while the planner records the concrete resolved integrator (`rk45` on adaptive time evolution) and execution lane in the runtime receipt (`resolved execution`).
- **Validation errors**: Non-positive `gamma`, negative `alpha`, simultaneous `fixed_timestep` and `adaptive_timestep`, or incompatible integrator/stepping pairs (`fixed_timestep` with `rk23`/`rk45`, or `adaptive_timestep` with `heun`/`rk4`/`abm3`/`coupled_imex_ark2`) raise immediate `ValueError` validation errors in Python and planner diagnostics in Rust.
- **Unsupported combinations**: Requesting FDM-only integrators (`abm3`, `coupled_imex_ark2`) on `target="fem"` or forcing GPU execution without a qualified native kernel fails closed without silent CPU fallback.

(physics-foundations-llg-equation-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

After spatial discretization of $\mathbf{H}_{\mathrm{eff}}$ on either an unstructured finite-element mesh (FEM) or a uniform Cartesian grid (FDM), {eq}`eq-llg-explicit` becomes a coupled system of ordinary differential equations $\dot{\mathbf{m}}_i = \mathbf{f}_i(\mathbf{m}, t)$ over all active magnetic degrees of freedom $i \in \mathcal{A}$:

- **FEM CPU (`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`)**: Evaluates the nodewise LLG right-hand side `llg_rhs_aos` on active magnetic nodes using the assembled nodal effective field $\mathbf{H}_{\mathrm{eff},i}$ and optional stage transport torques.
- **FEM GPU (`backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu`)**: Evaluates the fused device kernel `fullmag_cuda_llg_rhs_fused` directly on device-resident SoA/AoS buffers without host readback during explicit RK stage execution.
- **FDM CPU & GPU (`crates/fullmag-engine/src/fdm/cpu/integrators.rs` and `backends/fdm/gpu/cuda/`)**: Evaluates the cell-centered LLG right-hand side across active cells $M_{s,i} > 0$, supporting explicit `heun`, `rk4`, `rk23`, `rk45`, fixed-step `abm3`, and `coupled_imex_ark2` (for coupled magnetoelastic elastodynamics).

(physics-foundations-llg-equation-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Support status | Implementation notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM nodewise `llg_rhs_aos` and explicit RK (`heun`, `rk4`, `rk23`, `rk45`) in `backends/fem/cpu/mfem/integrators/`. |
| FEM | GPU | `source-backed` | Device-resident CUDA kernel `fullmag_cuda_llg_rhs_fused` and adaptive RK attempt loop; executed-device qualification is reported per run. |
| FDM | CPU | `documented` | Reference Cartesian SoA LLG evaluator with `heun`, `rk4`, `rk23`, `rk45`, `abm3`, and `coupled_imex_ark2`. |
| FDM | GPU | `source-backed` | CUDA LLG right-hand-side and reduction kernels; parity and device qualification depend on precision and active interactions. |

- **Control Room Dynamics & Solver Inspector**: Exposes `gamma`, `integrator`, fixed vs. adaptive timestep mode, and `AdaptiveTimestep` tolerances (`atol`, `rtol`, `dt_initial`, `dt_min`, `dt_max`, `safety`, `growth_limit`, `shrink_limit`).
- **Control Room Material Inspector**: Exposes region-level `Ms` ($\mathrm{A\,m^{-1}}$) and Gilbert damping `alpha` ($1$).

(physics-foundations-llg-equation-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- **Analytical macrospin precession**: Verified against exact Larmor frequency $f_0 = \gamma_0 H_0 / [2\pi(1+\alpha^2)]$ and exponential relaxation envelope in `packages/fullmag-py/tests/test_llg_solver_contract.py` and `backends/fem/tests/llg_rhs_contract.cpp`.
- **Standard Problem #4 & #5**: Validated across FEM and FDM lanes in `packages/fullmag-py/tests/test_standard_problem_4_fem.py`, `test_standard_problem_5_fdm.py`, and `test_standard_problem_5_fem.py`.

(physics-foundations-llg-equation-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- **Zero-saturation vacuum regions**: Cells or nodes with $M_{s,i} = 0$ are excluded from the active set $\mathcal{A}$ and maintain $\dot{\mathbf{m}}_i = \mathbf{0}$.
- **Explicit exchange stiffness**: On fine meshes or grids, the exchange operator eigenvalues scale as $\mathcal{O}(h^{-2})$, bounding the maximum stable explicit Runge–Kutta timestep (`LLG-TD-STIFF-V1`).
- **Stochastic thermal and callback fields**: When stochastic Brown thermal fluctuations or callback-driven stage currents are active, First-Same-As-Last (FSAL) stage reuse is automatically disabled (`gpu_rk_rhs_allows_fsal_reuse`).

(physics-foundations-llg-equation-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. L. D. Landau and E. M. Lifshitz, *On the theory of the dispersion of magnetic permeability in ferromagnetic bodies*, Phys. Z. Sowjetunion **8**, 153 (1935).
2. T. L. Gilbert, *A phenomenological theory of damping in ferromagnetic materials*, IEEE Trans. Magn. **40**, 3443 (2004).
3. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York (1963).

(physics-foundations-llg-equation-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | Public LLG contract, integrator normalization, and `ProblemIR` serialization |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | Embedded RK adaptive error tolerances and step-ratio bounds |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L141) | [`class FieldRefreshPolicy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L141) | Demagnetization field-refresh cadence policy |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | Stage-workflow `.solver(...)` configuration and `ProblemIR` compilation |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/llg_rhs.cpp#L30) | [`llg_rhs_aos`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/llg_rhs.cpp#L30) | Native FEM CPU nodewise LLG right-hand-side kernel |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu#L76) | [`fullmag_cuda_llg_rhs_fused`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu#L76) | Native FEM CUDA fused LLG right-hand-side kernel |
