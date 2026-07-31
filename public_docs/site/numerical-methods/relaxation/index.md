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

Three executable algorithms are currently exposed through the stage API:

| Algorithm | Numerical role | Time-step controls | Current qualification boundary |
|---|---|---|---|
| `llg_overdamped` | precession-disabled damping descent | fixed or adaptive RK controls | FDM and FEM lanes are implemented; runtime qualification is lane- and device-specific |
| `projected_gradient_bb` | projected gradient with alternating BB step selection | no physical or pseudo-time step | FDM reference and native FEM CPU/GPU implementations exist; executed-device evidence is separate |
| `nonlinear_cg` | Polak–Ribière+ tangent-space minimization | no physical or pseudo-time step | FDM reference and native FEM CPU/GPU implementations exist; executed-device evidence is separate |

`tangent_plane_implicit` is represented in the public algorithm vocabulary and has a native FEM
CPU implementation, but it is not presented here as a universally qualified production lane.
The planner must reject an unsupported solver/device combination instead of silently replacing the
requested algorithm.

## Workflow

The canonical user workflow is an executable `fm.study(...)` scenario. Geometry, material state,
interaction registration, solver policy, and the ordered relaxation stage are visible in one file:

```{toctree}
:maxdepth: 1

llg-relaxation
projected-gradient
stopping-criteria
```

The terminal pages define the equations, symbols and SI units, complete parameters, `ProblemIR`
mapping, failure semantics, realization matrix, and source-code index. The physical contract is
shared with [`docs/physics/0500-fdm-relaxation-algorithms.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0500-fdm-relaxation-algorithms.md),
[`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md),
and [`docs/physics/0580-canonical-relaxation-equilibrium-contract.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0580-canonical-relaxation-equilibrium-contract.md).
