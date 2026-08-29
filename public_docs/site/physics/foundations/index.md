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
## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
