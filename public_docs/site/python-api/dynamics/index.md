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
## Control Room crosswalk

Configure supported stage-level dynamics through `Model Explorer -> Stages -> Add stage -> <stage kind>`. The editor exposes only the fields listed by the relevant child page; `TODO: frontend support` marks solver, integrator, timestep, or refresh fields without a corresponding control. See {doc}`/frontend/capability-register`.

## API and source scope

This category index has no standalone callable. Child pages provide the exact Python API, governing equations, validation semantics, bibliography, and source-code index.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
