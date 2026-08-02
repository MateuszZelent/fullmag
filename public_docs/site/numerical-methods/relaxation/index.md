---
title: Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-relaxation-root)=
# Relaxation

Relaxation is a zero-temperature constrained minimization stage. It seeks a stationary
magnetization on the product of unit spheres, rather than advancing a physical-time experiment.
The same physical energy and effective-field definitions are used by FDM and FEM; the numerical
realization, field refresh policy, precision, memory ownership, and qualification evidence are
separate.

The stage API exposes three executable relaxation algorithms. They are not three names for one
implementation: `llg_overdamped` advances a damping-only LLG equation, while the two direct
minimizers operate on the constrained energy landscape without a physical-time coordinate.

| Algorithm | Numerical role | Time-step controls | Current qualification boundary |
|---|---|---|---|
| `llg_overdamped` | precession-disabled damping descent | fixed or adaptive RK controls; optional relaxation-time ceiling | FDM and FEM lanes are implemented; runtime qualification is lane- and device-specific |
| `projected_gradient_bb` | tangent projected gradient with alternating BB1/BB2 step selection and Armijo backtracking | no physical or pseudo-time step | FDM reference and native FEM CPU/GPU implementations exist; planner/runtime evidence is separate |
| `nonlinear_cg` | Polak–Ribière+ tangent-space conjugate minimization with Armijo backtracking and periodic restart | no physical or pseudo-time step | FDM reference and native FEM CPU/GPU implementations exist; planner/runtime evidence is separate |

`tangent_plane_implicit` is represented in the public algorithm vocabulary and has a native FEM
CPU development implementation, but it is not one of the three algorithms documented as an
executable public relaxation choice here.
The planner must reject an unsupported solver/device combination instead of silently replacing the
requested algorithm.

## Shared physical contract

All three algorithms use the same normalized magnetization and effective-field convention. For
each active cell or finite-element node,

```{math}
:label: eq-relax-shared-effective-field
\mathbf m_i=\frac{\mathbf M_i}{M_{s,i}},\qquad
\mathbf H_{\mathrm{eff},i}=-\frac{1}{\mu_0M_{s,i}}
\frac{\delta E}{\delta\mathbf m_i},\qquad
\boldsymbol\tau_i=\mathbf m_i\times\mathbf H_{\mathrm{eff},i}.
```

The accepted state is constrained by $\lVert\mathbf m_i\rVert_2=1$. The public default
`tolT=1e-6` is a torque threshold in tesla; the runtime comparison is made against
$\varepsilon_{\tau,\mathrm{A/m}}=10^{-6}/\mu_0=0.7957747154594767\ \mathrm{A\,m^{-1}}$.
The energy criterion, when present, is conjunctive with torque. `max_steps` and the LLG-only
time ceiling are budgets, never proofs of equilibrium.

## Algorithm selection and exact internal policy

| Question | `llg_overdamped` | `projected_gradient_bb` | `nonlinear_cg` |
|---|---|---|---|
| Mathematical object | pure-damping LLG ODE | constrained energy minimizer | constrained energy minimizer |
| Physical/pseudo-time | relaxation coordinate $t$ in seconds | none | none |
| Trial state | RK stage | normalized $\mathbf m-\lambda\mathbf g$ | normalized $\mathbf m+\lambda\mathbf p$ |
| Acceptance | integrator error policy | Armijo, $c_1=10^{-4}$, at most 20 backtracks | Armijo, $c_1=10^{-4}$, at most 30 backtracks |
| Internal step policy | fixed or adaptive RK23/RK45 | BB1/BB2 alternation, $10^{-15}\leq\lambda\leq10^{-3}$ | initial $\min(10^{-6},1/\lVert p\rVert)$; restart every 50 accepted steps |
| Public controls | solver, `dt*`, adaptive policy, damping override | stop criteria only | stop criteria only |

The constants in the table are implementation policy, not public keyword arguments. They are
recorded as resolved provenance when a backend exposes them. `tangent_plane_implicit` remains a
reserved vocabulary value and is not included in this three-algorithm public contract.

## Common stage API and IR boundary

The canonical authoring form is `study.stages.add_relax(...)`. The complete keyword surface is
`tol`, `tolA`, `tolT`, `max_steps`, `algorithm`, `energy_tolerance`,
`max_relaxation_time_s`, `max_pseudotime_s`, `max_physical_time_s`, `relax_alpha`, `solver`,
`dt`, `max_error`, `dt_min`, `dt_max`, `dt_initial`, `max_err`, `adaptive_timestep`,
`field_refresh`, and `stop`. `tol` is retained only as a rejected migration sentinel; use `tolT`
or `tolA`. The time aliases must agree and are valid only for `llg_overdamped`; all LLG controls
are rejected for the two direct minimizers.

Every algorithm lowers to the same shape, with `dynamics` present only for overdamped LLG:

```json
{
  "kind": "relaxation",
  "algorithm": "nonlinear_cg",
  "stop": {"torque_tolerance_apm": 0.7957747154594767, "max_steps": 50000},
  "sampling": {"outputs": []}
}
```

This is an explanatory projection of `Relaxation.to_ir()`, not an alternative authoring format.
Planner resolution (solver family, FDM/FEM, CPU/GPU, precision, mesh/grid and field policy) and
runtime completion/provenance are separate records.

## Four implementation lanes

| Physics algorithm | FDM CPU/reference | FDM GPU/CUDA | FEM CPU/MFEM | FEM GPU/CUDA |
|---|---|---|---|---|
| `llg_overdamped` | reference grid LLG path | CUDA LLG path | native MFEM LLG path | native device LLG path |
| `projected_gradient_bb` | reference cell loop | CUDA direct-minimizer loop | native MFEM step | native device step |
| `nonlinear_cg` | reference cell loop | CUDA direct-minimizer loop | native MFEM step with recovery | native device-resident step |

These are source/architecture statements, not blanket qualification claims. In particular, the
public multilayer FDM planner currently allows only `llg_overdamped`; single-layer/native direct
minimizer paths and executed GPU evidence must be checked separately.

## Workflow

The canonical user workflow is an executable `fm.study(...)` scenario. Geometry, material state,
interaction registration, solver policy, and the ordered relaxation stage are visible in one file:

```{toctree}
:maxdepth: 1

llg-relaxation
projected-gradient
nonlinear-cg
stopping-criteria
```

The three algorithm pages define their own equations, symbols and SI units, complete parameters,
`ProblemIR` mapping, failure semantics, realization matrix, and source-code index. The stopping
page defines the shared accepted-state completion contract. The physical contract is
shared with [`docs/physics/0500-fdm-relaxation-algorithms.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0500-fdm-relaxation-algorithms.md),
[`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md),
and [`docs/physics/0580-canonical-relaxation-equilibrium-contract.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0580-canonical-relaxation-equilibrium-contract.md).
