---
title: Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-relaxation)=
# `Relaxation` Study, `RelaxStop`, and `add_relax` Stage Contract

(python-api-studies-relaxation-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and overview

`fm.Relaxation` (together with `fm.RelaxStop` and the stage-workflow builder `study.stages.add_relax(...)` / `world.relax_stage(...)`) defines a micromagnetic equilibrium relaxation study or stage. It drives the magnetization field $\mathbf{m}(\mathbf{x})$ to a local minimum of the total micromagnetic energy $E[\mathbf{m}]$ where the local torque residual $\|\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}\|_2$ falls below the canonical stopping threshold $\varepsilon_{\tau}$ across at least three consecutive accepted states.

Fullmag supports four relaxation algorithm families (`Relaxation.algorithm`):

1. `"llg_overdamped"` — pure-damping Landau–Lifshitz–Gilbert integration ($s_{\mathrm{prec}} = 0$) with explicit Runge–Kutta (`heun`, `rk4`, `rk23`, `rk45`) or `abm3` stepping,
2. `"projected_gradient_bb"` — Riemannian projected gradient descent on $\mathbb{S}^2$ with Barzilai–Borwein step sizes and non-monotone/monotone Armijo line search,
3. `"nonlinear_cg"` — Riemannian nonlinear conjugate gradient minimization on $\mathbb{S}^2$ with vector transport and Armijo line search,
4. `"tangent_plane_implicit"` — linearly implicit tangent-space mass-plus-exchange solve with unit-sphere retraction and Armijo certification on the FEM CPU/MFEM development lane (`execution_mode="extended"`).

(python-api-studies-relaxation-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

At a local equilibrium on $\mathbb{S}^2$, the tangential component of the effective magnetic field vanishes at every active magnetic node or cell $i \in \mathcal{A}$ ($M_{s,i} > 0$):

```{math}
:label: eq-python-relaxation-torque
\boldsymbol{\tau}_i(\mathbf{m}) = \mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}),
\qquad
\tau_{\max}(\mathbf{m}) = \max_{i \in \mathcal{A}} \|\boldsymbol{\tau}_i(\mathbf{m})\|_2 \le \varepsilon_{\tau}.
```

When a user supplies `torque_tolerance` in tesla ($\tau_{\mathrm{T}}$ via `tolT`), `RelaxStop` normalizes it to the canonical field-residual threshold in $\mathrm{A\,m^{-1}}$ via vacuum permeability $\mu_0$:

```{math}
:label: eq-python-relaxation-tolerance-conversion
\varepsilon_{\tau} = \frac{\tau_{\mathrm{T}}}{\mu_0}.
```

(python-api-studies-relaxation-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{m}_i$ | Reduced magnetization unit vector at active point $i$ | $1$ |
| $\mathbf{H}_{\mathrm{eff},i}$ | Total effective magnetic field at point $i$ | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\tau}_i$ | Local effective-field torque residual $\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}$ | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max}$ | Maximum active-set torque residual norm | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_{\tau}$ | Canonical torque stopping threshold (`torque_tolerance_apm`) | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\mathrm{T}}$ | User-facing magnetic induction torque threshold (`tolT`) | $\mathrm{T}$ |
| $\mu_0$ | Vacuum permeability ($4\pi \times 10^{-7}\,\mathrm{N\,A^{-2}}$) | $\mathrm{N\,A^{-2}}$ |
| $\mathcal{A}$ | Active magnetic cell/node index set ($M_{s,i} > 0$) | $1$ |

(python-api-studies-relaxation-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **Local vs. global minimum**: All four relaxation algorithms converge to a local minimum (or stationary point) of $E[\mathbf{m}]$ within the basin of attraction of the initial state $\mathbf{m}_0$.
- **Three-consecutive-sample confirmation**: To prevent premature termination during transient zero crossings, `RelaxationTorqueConfirmation::observe` requires at least three consecutive accepted states satisfying $\tau_{\max} \le \varepsilon_{\tau}$ (and $\Delta E \le \varepsilon_E$ when `energy_tolerance_j` is active).
- **Direct-minimizer exclusivity with `LLG` dynamics**: Direct energy minimizers (`projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit`) manage their own line-search step sizes and reject an explicit `LLG` dynamics payload.

(python-api-studies-relaxation-python-api)=
<!-- (python-api)= -->
## 5. Python API and parameter contract

### Constructor and stage-builder signatures

```text
fm.RelaxStop(
    *,
    torque_tolerance_apm: float | None = 0.7957747154594767,
    energy_tolerance_j: float | None = None,
    max_steps: int | None = 50000,
    max_time_s: float | None = None,
)

fm.Relaxation(
    *,
    outputs: Sequence[TimeOutputSpec],
    algorithm: str = "llg_overdamped",
    stop: RelaxStop | None = None,
    torque_tolerance: float | None = None,
    energy_tolerance: float | None = None,
    max_steps: int | None = None,
    dynamics: LLG | None = None,
    constraints: Sequence[FrozenSpins] = (),
    table_autosave: TableAutosave | None = None,
)

study.stages.add_relax(
    *,
    name: str | None = None,
    algorithm: str = "llg_overdamped",
    tolT: float | None = None,
    tolA: float | None = None,
    energy_tolerance_j: float | None = None,
    max_steps: int = 50000,
    Bx: float | None = None,
    By: float | None = None,
    Bz: float | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Relaxation.outputs` | `Sequence[TimeOutputSpec]` | `required` | $1$ | Field/scalar outputs; an empty sequence is valid | Output requests recorded during relaxation | FEM/FDM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `Relaxation.algorithm` | `str` | `"llg_overdamped"` | $1$ | One of `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit` | Relaxation algorithm identifier | FEM/FDM CPU/GPU for `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`; FEM CPU extended lane for `tangent_plane_implicit` | `algorithm` |
| `Relaxation.stop` | `RelaxStop` | `RelaxStop()` | mixed | Positive tolerances and step counts; one time bound at most | Canonical stop contract | FEM/FDM CPU/GPU | `stop` |
| `Relaxation.torque_tolerance` | `float \| None` | `1e-5` (legacy alias) | $\mathrm{T}$ | Positive; conflicts with `stop.torque_tolerance_apm` are rejected | Convergence threshold on torque | FEM/FDM CPU/GPU | `stop.torque_tolerance_apm` |
| `Relaxation.energy_tolerance` | `float \| None` | `None` | $\mathrm{J}$ | Positive when set | Energy-delta stop bound | FEM/FDM CPU/GPU | `stop.energy_tolerance_j` |
| `Relaxation.max_steps` | `int \| None` | `50000` (legacy alias) | $1$ | Positive integer | Maximum relaxation iterations | FEM/FDM CPU/GPU | `stop.max_steps` |
| `Relaxation.dynamics` | `LLG \| None` | `None` | mixed | Required by `llg_overdamped` only; direct minimizers reject it | LLG parameters for the overdamped lane | FDM/FEM CPU/GPU | `dynamics` |
| `Relaxation.table_autosave` | `TableAutosave \| None` | `None` | mixed | See {doc}`../outputs/autosave` | Tabular autosave policy | FEM/FDM CPU/GPU | `sampling.table_autosave` |

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
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.2, 0.05)),
    demag=True,
)

study = fm.study(world, target="fdm", device="cpu", precision="fp64")
study.stages.add_relax(
    name="ground_state",
    algorithm="projected_gradient_bb",
    tolT=1e-6,
    max_steps=5000,
)

ir = study.to_problem_ir()
assert ir["study"]["stages"][0]["kind"] == "relax"
assert ir["study"]["stages"][0]["algorithm"] == "projected_gradient_bb"
```

(python-api-studies-relaxation-problem-ir)=
<!-- (problem-ir)= -->
## 6. `ProblemIR` and canonical script representation

```json
{
  "study": {
    "kind": "stage_workflow",
    "stages": [
      {
        "kind": "relax",
        "name": "ground_state",
        "algorithm": "projected_gradient_bb",
        "stop": {
          "torque_tolerance_apm": 0.7957747154594768,
          "energy_tolerance_j": null,
          "max_steps": 5000,
          "max_time_s": null
        }
      }
    ]
  }
}
```

(python-api-studies-relaxation-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `ProblemIR` stores the canonical `algorithm` and `stop` payload (`requested intent`), while the execution receipt records the resolved minimizer/integrator, terminal torque $\tau_{\max}$, accepted step count, and convergence status (`resolved execution`).
- **Validation errors**: Supplying both `tolT` and `tolA`, supplying `dynamics` to a direct minimizer (`projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit`), or non-positive tolerances/step limits raise immediate `ValueError` validation errors.
- **Unsupported combinations**: Requesting `tangent_plane_implicit` on `target="fdm"`, `device="gpu"`, or `execution_mode="strict"` is rejected as an unsupported combination by the planner.

(python-api-studies-relaxation-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

- **Overdamped LLG (`llg_overdamped`)**: Disables precession ($s_{\mathrm{prec}} = 0$) via `llg_overdamped_uses_pure_damping` and integrates the pure-damping ODE with adaptive (`rk45`, `rk23`) or fixed (`heun`, `rk4`, `abm3`) stepping.
- **Direct Riemannian minimizers (`projected_gradient_bb`, `nonlinear_cg`)**: Compute the sphere-projected gradient and advance with certified Armijo energy decrease on FEM CPU/GPU (`backends/fem/gpu/cuda/relaxation/pgbb.cpp`, `nonlinear_cg.cpp`) and FDM CPU/GPU (`execute_projected_gradient_bb`, `execute_nonlinear_cg`).
- **Tangent-plane implicit (`tangent_plane_implicit`)**: Solves the tangent-space mass-plus-exchange linear system in `run_tangent_plane_implicit_step` (`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`).

(python-api-studies-relaxation-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Status | Supported algorithms |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit` (extended mode) |
| FEM | GPU | `documented` | `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg` |
| FDM | CPU | `documented` | `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg` |
| FDM | GPU | `documented` | `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg` |

(python-api-studies-relaxation-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- Validated in `backends/fem/tests/relaxation_operator_contract.cpp`, `backends/fem/tests/relaxation_energy_derivative_contract.cpp`, and `packages/fullmag-py/tests/test_problem_ir.py`.

(python-api-studies-relaxation-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- Reaching `max_steps` or `max_time_s` without satisfying the three-sample torque/energy predicate fails closed and marks the relaxation stage as unconverged.

(python-api-studies-relaxation-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. J. Barzilai and J. M. Borwein, *Two-point step size gradient methods*, IMA J. Numer. Anal. **8**, 141–148 (1988).
2. S. Bartels and A. Prohl, *Convergence of an implicit finite element method for the Landau–Lifshitz–Gilbert equation*, SIAM J. Numer. Anal. **44**, 1405–1419 (2006).

(python-api-studies-relaxation-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L835) | [`class Relaxation`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L835) | Relaxation study and algorithm policy lowering |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L765) | [`class RelaxStop`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L765) | Relaxation stop criteria normalization |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3125) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3125) | Stage-workflow relaxation builder and lowering |
| Shared Runner | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/relaxation/convergence.rs#L63) | [`relaxation_converged`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/relaxation/convergence.rs#L63) | Accepted-state torque and energy convergence predicate |
| FEM Runner | [`crates/fullmag-runner/src/fem/relax/llg_overdamped.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/relax/llg_overdamped.rs#L174) | [`execute_llg_overdamped`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/relax/llg_overdamped.rs#L174) | Native FEM overdamped LLG relaxation execution |
| Native FEM CPU | [`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp#L1214) | [`run_tangent_plane_implicit_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp#L1214) | Native FEM CPU/MFEM tangent-plane implicit relaxation step |
