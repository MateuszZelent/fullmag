---
title: Dynamics
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-root)=
# Dynamics

Dynamics configures the time-evolution and overdamped-relaxation numerical policy: the `fm.LLG`
contract, time-integrator selection, `fm.AdaptiveTimestep` error control, and
`fm.FieldRefreshPolicy` demagnetization refresh cadence. Study stages consume this policy through
`study.solver(...)`, `study.stages.add_run(...)`, and `study.stages.add_relax(...)`.

For hardware-level GPU acceleration of explicit Runge–Kutta stepping, FSAL reuse, and fused
effective-field / spin-torque kernels, see {ref}`numerical-methods-performance-fdm-core`,
{ref}`numerical-methods-performance-fem-gpu-demag`, and
{ref}`numerical-methods-performance-fem-gpu-kernels`.

```{toctree}
:maxdepth: 1

llg
integrators
adaptive-timestep
field-refresh
```
