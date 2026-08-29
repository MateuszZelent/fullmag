---
title: Physical conventions and units
status: draft
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/llg_conventions.md
---

# Physical conventions and units

FullMag uses SI units unless a page explicitly states otherwise. Every interaction page defines
symbols, signs, coordinate orientation, magnetization normalization and assumptions.

| Symbol | Meaning | SI unit |
|---|---|---|
| m | normalized magnetization | dimensionless |
| M | magnetization | A/m |
| M_s | saturation magnetization | A/m |
| H | magnetic field | A/m |
| B | magnetic flux density | T |
| A | exchange stiffness | J/m |
| t | time | s |
| f | frequency | Hz |
| alpha | Gilbert damping parameter | dimensionless |

The project-wide convention is maintained in docs/physics/llg_conventions.md and
docs/physics/0000-physics-documentation-standard.md. Public pages may summarize it, but may not
introduce a second sign or unit convention.
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Geometry` or `Material` as named by the linked API page. Status: `partial`. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.
## Source-code index

- Public Python and lowering sources are linked by the applicable terminal API page. Runtime realization is in the relevant `backends/fdm` or `backends/fem` lane; frontend ownership is `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` where a live control exists.

