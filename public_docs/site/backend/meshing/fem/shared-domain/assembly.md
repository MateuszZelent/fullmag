---
title: Shared-Domain Assembly
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-shared-domain-assembly)=
# Shared-domain assembly

The preferred path fragments magnetic and air volumes in a common CAD/OCC model so adjacent regions
share one geometric interface. Independent object meshes must not simply be concatenated when the
physics requires conforming traces.

The build report records:

- requested and actual build mode;
- geometry components and Boolean-fragment results;
- algorithm retries and ordered fallbacks;
- whether a fallback preserved or degraded semantic identities;
- authored and realized region counts;
- orphan entities and connectivity components;
- extracted mesh and magnetic-submesh signatures.

`concatenated_stl_fallback` is degradation evidence because CAD component and selector identity may
be lost. A retry using another Gmsh algorithm can remain nondegrading only when region, interface,
and boundary ownership are demonstrably unchanged.

Primary implementation owners are `_gmsh_infra.py`, `_gmsh_extraction.py`, `_mesh_targets.py`, and
`mesh_build_report.py`.
