---
title: Time Integration
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: explicit-runge-kutta, adaptive-stepping, tangent-plane-methods
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

## Method families and canonical LLG time-domain policy

FullMag separates public time-integration requests (`LLG.integrator`) from backend/device execution while enforcing a unified mathematical and operational contract (`LLG-TD-POLICY-V1` through `LLG-TD-ATOMIC-V1`):

| Integrator identifier | Accepted aliases | Method family | Stage / step order | Stepping policy | Supported backend lanes |
| --- | --- | --- | --- | --- | --- |
| `"heun"` | — | Explicit two-stage Runge–Kutta (trapezoidal predictor–corrector) | $S=2$, $p=2$ | Fixed $\Delta t$ | FEM CPU/GPU, FDM CPU/GPU |
| `"rk4"` | — | Classical four-stage explicit Runge–Kutta | $S=4$, $p=4$ | Fixed $\Delta t$ | FEM CPU/GPU, FDM CPU/GPU |
| `"rk23"` | `"bs23"`, `"rk32"` | Bogacki–Shampine embedded 3(2) pair with FSAL | $S=4$, $p=2$ (error), $3$ (state) | Adaptive PI ($\Delta t \in [\Delta t_{\min}, \Delta t_{\max}]$) or fixed $\Delta t$ | FEM CPU/GPU, FDM CPU/GPU |
| `"rk45"` | `"dp54"` | Dormand–Prince 5(4) embedded pair with FSAL | $S=7$, $p=4$ (error), $5$ (state) | Adaptive PI ($\Delta t \in [\Delta t_{\min}, \Delta t_{\max}]$) or fixed $\Delta t$ | FEM CPU/GPU, FDM CPU/GPU |
| `"abm3"` | — | Three-step Adams–Bashforth–Moulton predictor–corrector with RK4 bootstrap | 3-step multistep ($p=3$) | Fixed $\Delta t$ + checkpoint resume (`FdmCpuSolverCheckpointV1`) | FDM CPU/GPU (FP64/FP32), FEM CPU reference (rejected by native FEM GPU ABI) |
| `"coupled_imex_ark2"` | — | Additive implicit–explicit Runge–Kutta (ARS(2,3,2)) for coupled transient spin-transport | $S=2$, $p=2$ | Adaptive step-halving (full step vs two half steps) or fixed $\Delta t$ | Coupled transient spin-transport lanes only (rejected for standalone LLG) |
| `"auto"` | — | Planner-resolved default (`"rk45"` for adaptive time evolution; `"rk23"` at relaxation stage lowering) | Resolved in plan receipt | Adaptive or fixed | FEM CPU/GPU, FDM CPU/GPU |

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

- **Explicit Runge–Kutta (`heun`, `rk4`, `rk23`, `rk45`) and fixed-step `abm3`**: Evaluates $S$ internal stage derivatives $\mathbf{k}_{s,i}$, normalizes intermediate stage states onto $\mathbb{S}^2$, and (for embedded pairs) computes the high-minus-low vector difference $\mathbf{e}_i = \Delta t \sum_{s=1}^{S}(b_s^{\mathrm{hi}} - b_s^{\mathrm{lo}})\mathbf{k}_{s,i}$. On GPU, FEM executes Heun/RK4/PBC FSAL `k0` reuse, a two-step linear demagnetizing potential predictor $\phi^{(0)}$, and fused short-range $H_{\mathrm{eff}}$/Exchange/DMI kernels, while FDM fuses FP64 RK45 prescribed spin torques into the field/RHS pass. See {doc}`explicit-runge-kutta`, {ref}`numerical-methods-performance-fem-gpu-demag`, {ref}`numerical-methods-performance-fem-gpu-kernels`, and {ref}`numerical-methods-performance-fdm-core`.
- **Order-aware history PI adaptive controller (`LLG-TD-POLICY-V1`, `LLG-TD-MAX-ERR-V1`, `LLG-TD-ATOMIC-V1`)**: Uses the maximum active-node mixed error norm $\rho_k = \max_{i \in \mathcal{A}} (\|\mathbf{e}_i\|_2 / \sigma_i)$ with $\sigma_i = \mathrm{atol} + \mathrm{rtol}\max(\|\mathbf{m}_i^{\mathrm{old}}\|_2, \|\mathbf{m}_i^{\mathrm{high}}\|_2)$ and updates $\Delta t_{k+1} = \widehat{q}_k \Delta t_k$ via the history-aware proportional–integral law $q_k = s\,\rho_k^{-0.7/(p+1)}\rho_{k-1}^{0.4/(p+1)}$. Rejected attempts roll back all state, field, and FSAL buffers atomically. See {doc}`adaptive-stepping`.
- **Tangent-plane projection and linearly implicit relaxation (`tangent_plane_implicit`)**: Enforces $\mathbf{m}_i \cdot \delta\mathbf{m}_i = 0$ in the local tangent plane $T_{\mathbf{m}_i}\mathbb{S}^2$ and solves a global $M_s$-weighted mass plus $2\tau/\mu_0$-scaled exchange linear system followed by unit-sphere retraction and Armijo energy verification on the FEM CPU/MFEM extended lane. See {doc}`tangent-plane-methods`.

## Canonical Python configuration

```python
# %% Configure an adaptive RK45 FDM time-evolution study
import fullmag as fm

nm = 1.0e-9
study = fm.study("time_integration_overview")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

strip = study.geometry(fm.Box(size=(80 * nm, 20 * nm, 5 * nm), name="strip"), name="strip")
strip.Ms = 8.0e5
strip.Aex = 1.3e-11
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.B_ext = (0.0, 5.0e-3, 0.0)
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
study.stages.add_run(until=0.2e-9, stage_id="pulse")
```
