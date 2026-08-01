---
title: Physics foundations
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/units.md
---

(public-docs-physics-foundations-root)=
# Physics foundations

These pages define the shared physical contract that every FullMag interaction, solver
backend, and observable must satisfy. They are not interaction-specific; instead they
establish the conventions, equations, and quantities that the interaction pages build upon.

Start with {doc}`conventions-and-units` for the SI unit table and solver-field naming, then
read {doc}`micromagnetic-energy` for the total energy and variational principle, and
{doc}`effective-field` for the field vs. torque distinction. The {doc}`llg-equation` page
defines the equation of motion. {doc}`boundary-conditions` covers the boundary-condition
types shared across interactions. {doc}`observables` documents the output system.

```{toctree}
:maxdepth: 1

conventions-and-units
micromagnetic-energy
effective-field
llg-equation
boundary-conditions
observables
```
