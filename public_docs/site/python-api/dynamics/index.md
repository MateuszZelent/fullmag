---
title: Dynamics
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-root)=
# Dynamics

Dynamics configures the time-evolution and relaxation numerical policy: the LLG solver, integrator
selection, adaptive timestep control, and field-refresh cadence. Study stages consume this policy
through `study.solver(...)` and `study.stages.add_*`.

```{toctree}
:maxdepth: 1

llg
integrators
adaptive-timestep
field-refresh
```
