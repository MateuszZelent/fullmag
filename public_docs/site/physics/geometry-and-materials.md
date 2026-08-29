---
title: Geometry, regions, materials and meshes
status: planned
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0100-mesh-and-region-discretization.md
---

# Geometry, regions, materials and meshes

Geometry and material semantics are physics inputs, not renderer-specific data. The same physical
object and region intent must be lowered to the selected FDM or FEM realization.

The first public scope covers geometry objects, transforms, region membership, material fields,
interfaces, FDM grids, FEM meshes, airboxes, periodicity, remeshing and invalidation.

FDM uses structured cells, masks and grid ownership. FEM uses elements, material markers,
boundary markers and shared domains. These representations differ while the public region and
material meaning stays the same.

The initial public fixtures are a rectangular object, a thin film and a shared-domain airbox.
Each fixture must expose mesh or grid identity, material regions, boundary policy and a
reproducible build report.

## Physical model

The public geometry contract describes a physical domain Omega, its magnetic subdomains Omega_i
and material fields assigned to those subdomains. A discretization must preserve the declared
region membership and boundary markers:

$$
Omega = union_i Omega_i,
qquad
Omega_i intersection Omega_j = emptyset for i != j
$$

This is the partition contract, not a claim that every overlapping authoring operation is valid.
Overlap resolution, interfaces and boolean operations must be documented explicitly before a mesh
is qualified.

## API and ProblemIR impact

The public authoring model must carry object geometry, transforms, region identity, material
assignment, discretization policy, boundary policy and mesh provenance. The planner resolves FDM
grid or FEM mesh capabilities without changing physical region meaning. Geometry changes invalidate
mesh-dependent artifacts; magnetization changes do not by themselves invalidate mesh identity.

## Validation strategy

The first fixtures are planned, not yet qualified:

1. a rectangular object with one material region;
2. a thin film with through-thickness discretization;
3. a shared-domain magnetic object and airbox;
4. a region mutation followed by remesh and certificate comparison.

Evidence must include mesh or grid identity, region markers, boundary policy and a reproducible
build report. No result is currently claimed by this page.

## Known limits and deferred work

This page does not yet qualify adaptive refinement, all boolean geometry operations, every
periodic boundary combination or every mixed FEM topology. Those topics remain deferred until
their public API, certificates and validation artifacts are linked.
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Geometry` or `Material` as named by the linked API page. Status: `partial`. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.
## Source-code index

- Public Python and lowering sources are linked by the applicable terminal API page. Runtime realization is in the relevant `backends/fdm` or `backends/fem` lane; frontend ownership is `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` where a live control exists.

