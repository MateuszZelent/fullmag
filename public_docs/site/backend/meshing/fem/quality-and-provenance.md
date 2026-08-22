---
title: FEM Mesh Quality And Provenance
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-quality-and-provenance)=
# FEM mesh quality and provenance

A generated mesh is accepted only after topology, semantics, geometry, and element-quality checks.

## Minimum report

- node, element, and boundary counts by family, order, region, and marker;
- magnetic, air, and shared-domain bounds and volumes;
- minimum and lower-percentile Jacobian or scaled-Jacobian metrics;
- SICN, gamma/radius, edge-length, characteristic-size, and volume distributions;
- inverted, degenerate, orphan, nonmanifold, and coincident-face counters;
- requested and realized topology, layer count, sweep axis, and element order;
- selector and periodic-pair resolution;
- requested/applied/ignored/degraded mesh operations and fields;
- build mode, ordered fallback history, mesher version, deterministic inputs;
- full mesh and magnetic-submesh content digests.

Average quality alone is insufficient because a small tail of invalid elements can dominate
conditioning or produce an invalid operator. The exact warning/rejection metric must be named.

CPU/GPU comparison requires the identical extracted mesh digest; separately regenerating nominally
equivalent meshes is not strict parity.
