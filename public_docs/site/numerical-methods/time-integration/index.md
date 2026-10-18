---
title: Time Integration
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: explicit-runge-kutta, adaptive-stepping, tangent-plane-methods, their source maps, and source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-time-integration-root)=
# Time Integration

Time integration advances the semi-discrete Landau–Lifshitz–Gilbert (LLG) equation {doc}`../../physics/foundations/llg-equation` across ordered time-evolution and relaxation stages while preserving the unit-sphere magnetization constraint $\|\mathbf{m}_i\|_2 = 1$ on active magnetic degrees of freedom.

```{toctree}
:maxdepth: 1

explicit-runge-kutta
adaptive-stepping
tangent-plane-methods
```

## Method families and canonical LLG time-domain policy (`0960`)

Fullmag separates public time-integration requests (`LLG.integrator`) from backend/device execution while enforcing a unified mathematical and operational contract (`LLG-TD-POLICY-V1` through `LLG-TD-ATOMIC-V1`):

| Integrator identifier | Method family | Stage / step order | Stepping policy | Supported backend lanes |
| --- | --- | --- | --- | --- |
| `"heun"` (alias `"euler"`) | Explicit two-stage Runge–Kutta (trapezoidal predictor–corrector) | $S=2$, $p=2$ | Fixed $\Delta t$ | FEM CPU/GPU, FDM CPU/GPU |
| `"rk4"` | Classical four-stage explicit Runge–Kutta | $S=4$, $p=4$ | Fixed $\Delta t$ | FEM CPU/GPU, FDM CPU/GPU |
| `"rk23"` | Bogacki–Shampine embedded 3(2) pair with FSAL | $S=4$, $p=2$ (error), $3$ (state) | Adaptive PI ($\Delta t \in [\Delta t_{\min}, \Delta t_{\max}]$) | FEM CPU/GPU, FDM CPU/GPU |
| `"rk45"` (alias `"dopri5"`) | Dormand–Prince 5(4) embedded pair with FSAL | $S=7$, $p=4$ (error), $5$ (state) | Adaptive PI ($\Delta t \in [\Delta t_{\min}, \Delta t_{\max}]$) | FEM CPU/GPU, FDM CPU/GPU |
| `"abm3"` | Three-step Adams–Bashforth–Moulton predictor–corrector with RK4 bootstrap | 3-step multistep ($p=3$) | Fixed $\Delta t$ + checkpoint resume (`FdmCpuSolverCheckpointV1`) | FDM CPU |
| `"coupled_imex_ark2"` | Additive implicit–explicit Runge–Kutta for coupled magnetoelastic dynamics | $S=2$, $p=2$ | Fixed $\Delta t$ | FDM CPU/GPU (coupled magnetoelastic lane) |
| `"auto"` | Planner-resolved default (`"rk45"` for adaptive time evolution) | Resolved in plan receipt | Adaptive or fixed | FEM CPU/GPU, FDM CPU/GPU |

## Core mathematical formulation

Every explicit single-step or multistep integrator advances the semi-discrete ODE system

$$
\frac{\mathrm{d}\mathbf{m}_i}{\mathrm{d}t}
=
\mathbf{f}_i(\mathbf{m}, t)
=
-\frac{\gamma_0}{1+\alpha_i^2}
\left[
s_{\mathrm{prec}}\,\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)
+
\alpha_i\,\mathbf{m}_i \times \left(\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)\right)
\right]
+
\boldsymbol{\tau}_{\mathrm{direct},i}(\mathbf{m}, t)
$$

for all active magnetic cells or nodes $i \in \mathcal{A}$ ($M_{s,i} > 0$).

- **Explicit Runge–Kutta (`heun`, `rk4`, `rk23`, `rk45`)**: Evaluates $S$ internal stage derivatives $\mathbf{k}_{s,i}$, normalizes intermediate stage states onto $\mathbb{S}^2$, and (for embedded pairs) computes the high-minus-low vector difference $\mathbf{e}_i = \Delta t \sum_{s=1}^{S}(b_s^{\mathrm{hi}} - b_s^{\mathrm{lo}})\mathbf{k}_{s,i}$. See {doc}`explicit-runge-kutta`.
- **Order-aware history PI adaptive controller (`LLG-TD-POLICY-V1`, `LLG-TD-MAX-ERR-V1`, `LLG-TD-ATOMIC-V1`)**: Uses the maximum active-node mixed error norm $\rho_k = \max_{i \in \mathcal{A}} (\|\mathbf{e}_i\|_2 / \sigma_i)$ with $\sigma_i = \mathrm{atol} + \mathrm{rtol}\max(\|\mathbf{m}_i^{\mathrm{old}}\|_2, \|\mathbf{m}_i^{\mathrm{high}}\|_2)$ and updates $\Delta t_{k+1} = \widehat{q}_k \Delta t_k$ via the history-aware proportional–integral law $q_k = s\,\rho_k^{-0.7/(p+1)}\rho_{k-1}^{0.4/(p+1)}$. Rejected attempts roll back all state, field, and FSAL buffers atomically. See {doc}`adaptive-stepping`.
- **Tangent-plane projection and linearly implicit relaxation (`tangent_plane_implicit`)**: Enforces $\mathbf{m}_i \cdot \delta\mathbf{m}_i = 0$ in the local tangent plane $T_{\mathbf{m}_i}\mathbb{S}^2$ and solves a global mass-plus-exchange linear system followed by unit-sphere retraction and Armijo energy verification on the FEM CPU/MFEM development lane. See {doc}`tangent-plane-methods`.

## Canonical Python configuration

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
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.0, 0.0)),
    demag=True,
)

study = fm.study(world, target="fdm", device="cpu", precision="fp64")
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1e-6,
        rtol=1e-4,
        dt_initial=1e-13,
        dt_min=1e-15,
        dt_max=5e-12,
    ),
)
study.stages.add_time(name="pulse", duration=0.2e-9, By=5e-3, save_m_every=50e-12)
```
