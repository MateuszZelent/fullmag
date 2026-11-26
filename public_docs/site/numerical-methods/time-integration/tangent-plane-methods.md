---
title: Tangent Plane Methods
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "Relaxation validation, relax-stage lowering, and native FEM CPU tangent-plane implicit step"
---

(public-docs-numerical-methods-time-integration-tangent-plane-methods)=
# Tangent-Plane Projection and Linearly Implicit Relaxation

(numerical-methods-time-integration-tangent-plane-methods-problem-statement)=
## Scope and purpose

This chapter documents the tangent-plane projection formalism and the native FEM linearly implicit tangent-plane relaxation method (`tangent_plane_implicit` in `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`). Because the reduced magnetization $\mu_i \in \mathbb{S}^2$ evolves on the unit sphere, any physically admissible velocity or search direction $\mathbf{w}_i$ must lie in the local tangent space $T_{\mu_i}\mathbb{S}^2$. `tangent_plane_implicit` solves a global $2N_{\mathcal{A}}$-dimensional tangent-space mass-plus-exchange linear system (optionally augmented by local anisotropy/Zeeman curvature and matrix-free non-exchange tangent terms), retracts $\mu_i + \tau \mathbf{w}_i$ back onto $\mathbb{S}^2$, and enforces a strict Armijo energy-decrease gate with roundoff bounds.

(numerical-methods-time-integration-tangent-plane-methods-governing-equations)=
## Scientific and numerical model

At each active magnetic node $i \in \mathcal{A}$ with unit magnetization $\mu_i \in \mathbb{S}^2$ ($\|\mu_i\|_2 = 1$), the orthogonal projector onto the local tangent plane $T_{\mu_i}\mathbb{S}^2 = \{v \in \mathbb{R}^3 : \mu_i \cdot v = 0\}$ is

```{math}
:label: eq-tangent-projector
P_i = I - \mu_i \mu_i^{\mathsf{T}}.
```

Projecting the local effective magnetic field $H_{\mathrm{eff},i}$ onto $T_{\mu_i}\mathbb{S}^2$ isolates the negative tangent energy gradient $\mathbf{g}_i = -H_i^{\perp}$ on the sphere:

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

In `run_tangent_plane_implicit_step` (`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`), each active node $i$ is equipped with an orthonormal tangent frame $(\mathbf{e}_{1,i}, \mathbf{e}_{2,i})$ spanning $T_{\mu_i}\mathbb{S}^2$. Writing the field-valued tangent search direction as $\mathbf{w}_i = w_{1,i}\mathbf{e}_{1,i} + w_{2,i}\mathbf{e}_{2,i}$ treats the stiff exchange stiffness $K_{\mathrm{ex},ij} = \int_{\Omega_m} A_{\mathrm{ex}}\nabla\phi_i\cdot\nabla\phi_j\,\mathrm{d}V$ implicitly against the $M_s$-weighted mass matrix $M_{ij} = \int_{\Omega_m} M_s\phi_i\phi_j\,\mathrm{d}V$ with dimensional exchange scaling $2\tau/\mu_0$ (`exchange_hessian_scale_from_step_m_per_a` in `backends/fem/src/relaxation_operator_units.hpp`):

```{math}
:label: eq-tangent-implicit-system
\left(M_{\perp} + \frac{2\tau}{\mu_0}\,K_{\mathrm{ex},\perp}\right) w = r_{\perp}(H_{\mathrm{eff}}),
\qquad
\mu_i^{\mathrm{trial}}(\tau)
=
\frac{\mu_i + \tau\,\mathbf{w}_i(\tau)}{\|\mu_i + \tau\,\mathbf{w}_i(\tau)\|_2},
```

where the tangent-projected right-hand side is $r_{\perp} = -E_{\perp}^{\mathsf{T}} M \mathbf{g}$ (equivalently $+E_{\perp}^{\mathsf{T}} M H^{\perp}$). When local anisotropy, Zeeman, or other non-exchange operators are active, their tangent curvature contributions are assembled or applied matrix-free alongside $M_{\perp} + (2\tau/\mu_0) K_{\mathrm{ex},\perp}$. The retracted trial state $\mu^{\mathrm{trial}}(\tau)$ is accepted only when the certified direct-energy upper bound satisfies the Armijo descent condition; otherwise $\tau$ is halved and the pre-trial state is restored via `restore_previous_relaxation_state`.

(numerical-methods-time-integration-tangent-plane-methods-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mu_i$ | normalized magnetization at node $i$ | $1$ |
| $P_i$ | tangent-space projector | $1$ |
| $I$ | three-dimensional identity tensor | $1$ |
| $H_{\mathrm{eff},i}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $H_i^{\perp}$ | projected effective field | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{\perp}$ | tangent-projected $M_s$-weighted mass operator | $\mathrm{A\,m^2}$ |
| $K_{\mathrm{ex},\perp}$ | tangent-projected $A_{\mathrm{ex}}$-weighted exchange stiffness operator | $\mathrm{J}$ |
| $w$ | two-component tangent-frame search direction coordinates | $\mathrm{A\,m^{-1}}$ |
| $r_{\perp}$ | tangent-projected mass-weighted residual | $\mathrm{A^2\,m}$ |
| $\tau$ | implicit tangent-plane trial step size (`step_m_per_a`) | $\mathrm{m\,A^{-1}}$ |

(numerical-methods-time-integration-tangent-plane-methods-assumptions-and-validity)=
### Assumptions, Armijo certification, and lane scope

- **Orthonormal tangent basis**: At each step, `TangentFrame` constructs $(\mathbf{e}_{1,i}, \mathbf{e}_{2,i})$ orthogonal to $\mu_i$ so that $\mu_i \cdot \mathbf{w}_i = 0$ holds to machine precision before retraction.
- **Consistent SI operator scaling**: Both $M_{\perp}$ and $(2\tau/\mu_0)K_{\mathrm{ex},\perp}$ carry units $\mathrm{A\,m^2}$, so multiplying by $w$ ($\mathrm{A\,m^{-1}}$) matches $r_{\perp}$ ($\mathrm{A^2\,m}$), and the retraction increment $\tau\mathbf{w}_i$ is dimensionless ($1$).
- **Armijo energy gate with roundoff certification**: `run_tangent_plane_implicit_step` checks strict descent ($\langle \mathbf{w}, \mathbf{g}\rangle_E < 0$) and requires the certified direct-energy difference to satisfy the Armijo condition before advancing.
- **Extended-lane scope**: `tangent_plane_implicit` is an extended-mode FEM CPU/MFEM development algorithm (`study.engine("fem")`, `study.device("cpu", precision="double")`, `study.mode("extended")`). It is rejected on FDM, forced GPU lanes, and `study.mode("strict")`. For GPU-accelerated FEM relaxation with exchange preconditioning, see {doc}`../relaxation/projected-gradient` and {ref}`numerical-methods-performance-fem-gpu-kernels`.

(numerical-methods-time-integration-tangent-plane-methods-discrete-realization)=
(numerical-methods-time-integration-tangent-plane-methods-implementation-mapping)=
### Discrete realization and backend support matrix

| Solver | Device | Status | Realization notes |
| --- | --- | --- | --- |
| FEM | CPU | `source-backed` | Native MFEM tangent-space assembly, CG/MINRES/GMRES linear solve, unit-sphere retraction, and Armijo line search in `run_tangent_plane_implicit_step`. Requires `study.mode("extended")`. |
| FEM | GPU | `unsupported` | `tangent_plane_implicit` has no GPU implementation; forced GPU execution fails closed (`frozen_spins_fem_gpu_tpi_unqualified`). Use `projected_gradient_bb` with `bb_exchange_mass` on FEM GPU instead. |
| FDM | CPU | `unsupported` | The public contract marks `tangent_plane_implicit` as FEM-only; FDM planners reject it explicitly. |
| FDM | GPU | `unsupported` | The public contract marks `tangent_plane_implicit` as FEM-only; FDM planners reject it explicitly. |

## Parameters

| Python surface | Type | Default | SI unit | Validation / constraints | Meaning | Backend support | `ProblemIR` path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Relaxation.algorithm` | `str` | `llg_overdamped` | $1$ | supported identifier; unknown names rejected | relaxation algorithm request | FEM CPU extended lane for `tangent_plane_implicit`; FDM/GPU rejected | `study.relaxation.algorithm` |
| `RelaxStop.torque_tolerance_apm` | `float \| None` | `0.7957747154594767` | $\mathrm{A\,m^{-1}}$ | positive when set | torque stopping threshold | FEM/FDM relaxation stop contract | `study.relaxation.stop.torque_tolerance_apm` |
| `RelaxStop.max_steps` | `int \| None` | `50000` | $1$ | positive integer when set | iteration limit | FEM/FDM relaxation stop contract | `study.relaxation.stop.max_steps` |

(numerical-methods-time-integration-tangent-plane-methods-python-api)=
## Python API

```python
# %% Configure extended-mode FEM CPU tangent-plane implicit relaxation
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_tpi_relaxation")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("extended")
study.universe(mode="manual", size=(150 * nm, 80 * nm, 60 * nm))

nanodot = study.geometry(
    fm.Box(size=(50 * nm, 20 * nm, 5 * nm), name="nanodot"),
    name="nanodot",
)
nanodot.Ms = 8.0e5
nanodot.Aex = 1.3e-11
nanodot.alpha = 0.02
nanodot.m = fm.texture.uniform(1.0, 0.2, 0.1)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="tpi_relax",
    algorithm="tangent_plane_implicit",
    tolT=1e-6,
    max_steps=2000,
)
```

(numerical-methods-time-integration-tangent-plane-methods-problem-ir)=
### `ProblemIR` excerpt

```json
{
  "study": {
    "kind": "stage_workflow",
    "stages": [
      {
        "kind": "relax",
        "stage_id": "tpi_relax",
        "algorithm": "tangent_plane_implicit",
        "stop": {
          "torque_tolerance_apm": 0.7957747154594767,
          "energy_tolerance_j": null,
          "max_steps": 2000,
          "max_relaxation_time_s": null
        }
      }
    ]
  }
}
```

## Control Room workflow

- **Relaxation Stage Inspector**: Exposes `algorithm="tangent_plane_implicit"` when `engine="fem"` and `mode="extended"` are selected, along with stopping thresholds (`torque_tolerance_apm`, `energy_tolerance_j`, `max_steps`).
- **Execution Provenance**: Records `requested_energy_minimizer="tangent_plane_implicit"` and `resolved_energy_minimizer="tangent_plane_implicit"` in the relaxation stage receipt.

(numerical-methods-time-integration-tangent-plane-methods-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent and resolved execution**: `ProblemIR` records `algorithm="tangent_plane_implicit"` (`requested intent`), and the FEM runner records the CPU/MFEM development lane in the execution receipt (`resolved execution`).
- **Validation errors**: Unknown algorithm names, non-positive stopping tolerances, or LLG timestep options passed to `tangent_plane_implicit` raise immediate `ValueError` validation errors in Python and planner diagnostics in Rust.
- **Unsupported combinations**: Requesting `tangent_plane_implicit` on `engine="fdm"`, `mode="strict"`, or `device="gpu"` fails closed with explicit planner diagnostics.

(numerical-methods-time-integration-tangent-plane-methods-validation)=
## Validation

- **Unit and operator checks**: `exchange_hessian_scale_from_step_m_per_a` and `local_field_curvature_operator_entry` enforce dimensional consistency across $M_s$-weighted mass, $A_{\mathrm{ex}}$-weighted exchange, and local field curvature operators.
- **Development-lane status**: `tangent_plane_implicit` remains a development-executable FEM CPU algorithm (`capability-matrix` status `development_executable`); universal production qualification is not claimed.

(numerical-methods-time-integration-tangent-plane-methods-limitations)=
## Limitations

- Restricted to FEM CPU in `extended` mode; there is no FEM GPU or FDM implementation.
- On FEM GPU, stiff exchange relaxation should use `projected_gradient_bb` with the qualified default `bb_exchange_mass` preconditioner ({doc}`../relaxation/projected-gradient`, {ref}`numerical-methods-performance-fem-gpu-kernels`).

(numerical-methods-time-integration-tangent-plane-methods-scientific-bibliography)=
### Scientific bibliography

1. S. Bartels and A. Prohl, *Convergence of an implicit finite element method for the Landau–Lifshitz–Gilbert equation*, SIAM J. Numer. Anal. **44**, 1405–1419 (2006), DOI: [10.1137/050631070](https://doi.org/10.1137/050631070).
2. F. Alouges, *A new finite element scheme for Landau–Lifshitz equations*, Discrete Contin. Dyn. Syst. Ser. S **1**, 187–196 (2008), DOI: [10.3934/dcdss.2008.1.187](https://doi.org/10.3934/dcdss.2008.1.187).

(numerical-methods-time-integration-tangent-plane-methods-source-code-index)=
## Where this is implemented

| Layer | File | Symbol | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | [`class Relaxation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | Public relaxation algorithm validation and IR lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | Ordered stage capture and validation |
| Native FEM Units | [`backends/fem/src/relaxation_operator_units.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/relaxation_operator_units.hpp#L7) | [`exchange_hessian_scale_from_step_m_per_a`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/relaxation_operator_units.hpp#L7) | Exact SI exchange Hessian scale $2\tau/\mu_0$ for `step_m_per_a` |
| Native FEM CPU | [`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp#L1214) | [`run_tangent_plane_implicit_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp#L1214) | Native FEM CPU/MFEM tangent-plane implicit linear solve, retraction, and Armijo gate |
