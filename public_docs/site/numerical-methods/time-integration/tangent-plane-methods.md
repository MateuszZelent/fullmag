---
title: Tangent Plane Methods
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
source_of_truth: "Relaxation validation, relax-stage lowering, and planner capability status"
---

(public-docs-numerical-methods-time-integration-tangent-plane-methods)=
# Tangent-Plane Projection and Linearly Implicit Relaxation

(numerical-methods-time-integration-tangent-plane-methods-problem-statement)=
<!-- (problem-statement)= -->
## Scope and purpose

This chapter documents the tangent-plane projection formalism and the native FEM linearly implicit tangent-plane relaxation method (`tangent_plane_implicit` in `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`). Because the reduced magnetization $\mu_i \in \mathbb{S}^2$ evolves on the unit sphere, any physically admissible velocity or quasi-Newton step $\delta\mu_i$ must lie in the local tangent space $T_{\mu_i}\mathbb{S}^2$. `tangent_plane_implicit` solves a global tangent-space mass-plus-exchange linear system at each step, retracts the trial increment back onto $\mathbb{S}^2$, and enforces a strict Armijo energy-decrease gate with roundoff bounds.

(numerical-methods-time-integration-tangent-plane-methods-governing-equations)=
<!-- (governing-equations)= -->
## Scientific and numerical model

At each active magnetic node $i \in \mathcal{A}$ with unit magnetization $\mu_i \in \mathbb{S}^2$ ($\|\mu_i\|_2 = 1$), the orthogonal projector onto the local tangent plane $T_{\mu_i}\mathbb{S}^2 = \{v \in \mathbb{R}^3 : \mu_i \cdot v = 0\}$ is

```{math}
:label: eq-tangent-projector
P_i = I - \mu_i \mu_i^{\mathsf{T}}.
```

Projecting the local effective magnetic field $H_{\mathrm{eff},i}$ onto $T_{\mu_i}\mathbb{S}^2$ isolates the steepest-descent component of the negative energy gradient on the sphere:

```{math}
:label: eq-tangent-field
H_i^{\perp}
=
P_i H_{\mathrm{eff},i}
=
H_{\mathrm{eff},i} - \left(\mu_i \cdot H_{\mathrm{eff},i}\right)\mu_i
=
-\mu_i \times \left(\mu_i \times H_{\mathrm{eff},i}\right).
```

In `run_tangent_plane_implicit_step` (`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`), each active node $i$ is equipped with an orthonormal tangent frame $(\mathbf{e}_{1,i}, \mathbf{e}_{2,i})$ spanning $T_{\mu_i}\mathbb{S}^2$. Writing the trial tangent increment as $\delta\mu_i = w_{1,i}\mathbf{e}_{1,i} + w_{2,i}\mathbf{e}_{2,i}$ treats the stiff exchange operator implicitly in the $2N_{\mathcal{A}}$-dimensional tangent space while evaluating non-exchange interactions explicitly from the current $H_{\mathrm{eff}}$ snapshot:

```{math}
:label: eq-tangent-implicit-system
\left(M_{\perp} + \tau\,K_{\mathrm{ex},\perp}\right) w = r_{\perp}(H_{\mathrm{eff}}),
\qquad
\mu_i^{\mathrm{trial}}(\tau)
=
\frac{\mu_i + \delta\mu_i(\tau)}{\|\mu_i + \delta\mu_i(\tau)\|_2}.
```

The retracted trial state $\mu^{\mathrm{trial}}(\tau)$ is accepted only when the certified upper bound on the energy change $\Delta E + \varepsilon_{\mathrm{roundoff}}$ satisfies the Armijo descent condition; otherwise $\tau$ is halved and the pre-trial state is restored via `restore_after_rejected_trial`.

(numerical-methods-time-integration-tangent-plane-methods-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mu_i$ | normalized magnetization at point i | $1$ |
| $P_i$ | tangent-space projector | $1$ |
| $I$ | three-dimensional identity tensor | $1$ |
| $H_{\mathrm{eff},i}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $H_i^{\perp}$ | projected effective field | $\mathrm{A\,m^{-1}}$ |
| $M_{\perp}$ | tangent-space lumped/consistent mass operator | $\mathrm{J}$ |
| $K_{\mathrm{ex},\perp}$ | tangent-space projected exchange stiffness operator | $\mathrm{J\,s^{-1}}$ |
| $w$ | two-component tangent-frame increment coordinates | $1$ |
| $r_{\perp}$ | tangent-projected energy-gradient residual | $\mathrm{J}$ |
| $\tau$ | implicit tangent-plane trial step size | $1$ |

(numerical-methods-time-integration-tangent-plane-methods-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
### Assumptions, Armijo certification, and lane scope

- **Orthonormal tangent basis**: At each step, `TangentFrame` constructs $(\mathbf{e}_{1,i}, \mathbf{e}_{2,i})$ orthogonal to $\mu_i$ so that $\mu_i \cdot \delta\mu_i = 0$ holds to machine precision before retraction.
- **Armijo energy gate with roundoff certification**: `run_tangent_plane_implicit_step` requires $\Delta E + \varepsilon_{\mathrm{roundoff}} \le \Delta E_{\mathrm{Armijo}} \le 0$ and validates the accepted tangent gradient before advancing.
- **Development-lane scope**: `tangent_plane_implicit` is an extended-mode FEM CPU/MFEM algorithm (`target="fem"`, `execution_mode="extended"`). It is rejected on FDM, forced GPU lanes, and `execution_mode="strict"`.

(numerical-methods-time-integration-tangent-plane-methods-discrete-realization)=
<!-- (discrete-realization)= -->
(numerical-methods-time-integration-tangent-plane-methods-implementation-mapping)=
<!-- (implementation-mapping)= -->
### Discrete realization and backend support matrix

| Solver | Device | Status | Realization notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM tangent-space assembly, CG linear solve, unit-sphere retraction, and Armijo line search in `run_tangent_plane_implicit_step`. Requires `execution_mode="extended"`. |
| FEM | GPU | `unsupported` | `tangent_plane_implicit` has no GPU implementation; forced GPU execution fails closed (`frozen_spins_fem_gpu_tpi_unqualified`). |
| FDM | CPU | `unsupported` | The public contract marks `tangent_plane_implicit` as FEM-only; FDM planners reject it explicitly. |
| FDM | GPU | `unsupported` | The public contract marks `tangent_plane_implicit` as FEM-only; FDM planners reject it explicitly. |

## Parameters

| Python surface | Type | Default | SI unit | Validation / constraints | Meaning | Backend support | `ProblemIR` path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Relaxation.algorithm` | `str` | `llg_overdamped` | $1$ | supported identifier; unknown names rejected | relaxation algorithm request | FEM CPU extended lane for `tangent_plane_implicit`; FDM/GPU rejected | `study.relaxation.algorithm` |
| `RelaxStop.torque_tolerance_apm` | `float \| None` | `0.7957747154594767` | $\mathrm{A\,m^{-1}}$ | positive when set | torque stopping threshold | FEM/FDM relaxation stop contract | `study.relaxation.stop.torque_tolerance_apm` |
| `RelaxStop.max_steps` | `int \| None` | `50000` | $1$ | positive integer when set | iteration limit | FEM/FDM relaxation stop contract | `study.relaxation.stop.max_steps` |

(numerical-methods-time-integration-tangent-plane-methods-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %%
import fullmag as fm

world = fm.World(
    dx=5e-9,
    dy=5e-9,
    dz=5e-9,
    nx=10,
    ny=4,
    nz=1,
    boundaries=fm.BoundaryConfig.open(method="poisson_robin"),
)
world.add_box(
    "nanodot",
    size=(50e-9, 20e-9, 5e-9),
    material=fm.Material.permalloy(Ms=8.0e5, Aex=1.3e-11, alpha=0.02),
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.2, 0.1)),
    demag=True,
)

study = fm.study(
    world,
    target="fem",
    device="cpu",
    precision="fp64",
    execution_mode="extended",
)
study.stages.add_relax(
    name="tpi_relax",
    algorithm="tangent_plane_implicit",
    tolT=1e-6,
    max_steps=2000,
)

ir = study.to_problem_ir()
assert ir["study"]["stages"][0]["algorithm"] == "tangent_plane_implicit"
```

(numerical-methods-time-integration-tangent-plane-methods-problem-ir)=
<!-- (problem-ir)= -->
### `ProblemIR` excerpt

```json
{
  "study": {
    "kind": "stage_workflow",
    "stages": [
      {
        "kind": "relax",
        "name": "tpi_relax",
        "algorithm": "tangent_plane_implicit",
        "stop": {
          "torque_tolerance_apm": 0.7957747154594768,
          "energy_tolerance_j": null,
          "max_steps": 2000,
          "max_time_s": null
        }
      }
    ]
  }
}
```

## Control Room workflow

- **Relaxation Stage Inspector**: Exposes `algorithm="tangent_plane_implicit"` when `target="fem"` and `execution_mode="extended"` are selected, along with stopping thresholds (`torque_tolerance_apm`, `energy_tolerance_j`, `max_steps`).
- **Execution Provenance**: Records `requested_energy_minimizer="tangent_plane_implicit"` and `resolved_energy_minimizer="tangent_plane_implicit"` in the relaxation stage receipt.

(numerical-methods-time-integration-tangent-plane-methods-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
(numerical-methods-time-integration-tangent-plane-methods-validation)=
<!-- (validation)= -->
(numerical-methods-time-integration-tangent-plane-methods-limitations)=
<!-- (limitations)= -->
## Diagnostics and failure semantics

- **Requested intent and resolved execution**: `ProblemIR` records `algorithm="tangent_plane_implicit"` (`requested intent`), and the FEM runner records the CPU/MFEM development lane in the execution receipt (`resolved execution`).
- **Validation errors**: Unknown algorithm names or non-positive stopping tolerances raise immediate `ValueError` validation errors in Python and planner diagnostics in Rust.
- **Unsupported combinations**: Requesting `tangent_plane_implicit` on `target="fdm"`, `execution_mode="strict"`, or `device="gpu"` is rejected as an unsupported combination with an explicit diagnostic (`crates/fullmag-plan/src/validate.rs`).

(numerical-methods-time-integration-tangent-plane-methods-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
### Scientific bibliography

1. S. Bartels and A. Prohl, *Convergence of an implicit finite element method for the Landau–Lifshitz–Gilbert equation*, SIAM J. Numer. Anal. **44**, 1405–1419 (2006).
2. F. Alouges, *A new finite element scheme for Landau–Lifshitz equations*, Discrete Contin. Dyn. Syst. Ser. S **1**, 187–196 (2008).

(numerical-methods-time-integration-tangent-plane-methods-source-code-index)=
<!-- (source-code-index)= -->
## Where this is implemented

| Layer | File | Symbol | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L835) | [`class Relaxation`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L835) | Public relaxation algorithm validation and IR lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3125) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3125) | Ordered stage capture and validation |
| Native FEM CPU | [`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp#L1214) | [`run_tangent_plane_implicit_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp#L1214) | Native FEM CPU/MFEM tangent-plane implicit linear solve, retraction, and Armijo gate |
