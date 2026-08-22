---
title: FEM Mesh Build And Reports API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-build-and-reports)=
# FEM mesh build and reports API

`study.build_domain_mesh()` explicitly requests materialization of the current geometry, universe,
object, region, periodic, and mesh-policy revisions.

A build is distinct from authoring. Changing geometry or any mesh policy after a successful build
invalidates the current realization.

The durable result should expose:

- request and build revisions;
- requested and effective targets;
- build mode, algorithms, optimizer, fallbacks, and degradation;
- region, boundary, periodic, selector, and submesh identities;
- element/facet families, counts, order, layer planes, and topology;
- size, volume, Jacobian, SICN, gamma/radius, and edge statistics;
- operation and size-field status;
- Gmsh/native extraction versions and mesh digest;
- completed, failed, interrupted, or stale state.

Control Room uses the corresponding object/universe policy resources, current build resource, latest
successful build resource, object/region reports, and quality resources. Python and UI therefore
share one lifecycle rather than maintaining independent meshes.
