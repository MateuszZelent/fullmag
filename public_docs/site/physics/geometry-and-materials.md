---
title: Geometry, regions, materials and meshes
status: draft
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
