---
title: Boundary Conditions
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

(public-docs-python-api-boundary-conditions-root)=
# Boundary Conditions

Boundary conditions constrain magnetic, magnetostatic, and mechanical fields at domain boundaries:

- **Periodic boundary conditions**: zero-phase translational periodicity across paired FEM boundaries (`fm.PeriodicBC`), structured FDM periodic axes and demag image policies (`fm.FdmPbc`, `study.pbc(...)`), and modal magnetostatic airbox policies (`magnetostatic_bc="periodic_airbox_k0"` vs isolated `"open_airbox_k0"`).
- **Floquet boundary conditions**: complex Bloch phase-twisted boundary constraints (`fm.FloquetBC`) for wave-vector-resolved spin-wave eigenmodes and steady-state frequency response (`magnetostatic_bc="floquet_airbox"`).
- **Mechanical boundary conditions and loads**: displacement, traction, clamped, and traction-free surface conditions (`fm.MechanicalBoundaryCondition`) plus volumetric body-force, prescribed-strain, and prescribed-stress loads (`fm.MechanicalLoad`) for magnetoelastic studies.
- **Absorbing boundary layers (ABLs)**: spatially graded Gilbert damping layers (`fm.AbsorbingBoundaryLayer`, `fm.AbsorbingGeometry`, `fm.SpatialAbsorbingLayer`, and `film.alpha.absorbing_boundary(...)`) suppress spin-wave reflections at open waveguide ends; see {doc}`../magnets-and-textures/ferromagnet` for the full Python API.

```{toctree}
:maxdepth: 1

periodic-boundary-conditions
floquet-boundary-conditions
mechanical-boundary-conditions
```
