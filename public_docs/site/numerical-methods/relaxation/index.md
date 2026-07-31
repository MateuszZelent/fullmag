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
