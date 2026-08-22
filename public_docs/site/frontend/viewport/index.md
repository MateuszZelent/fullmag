---
title: Viewport And Mesh Visualization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-viewport-root)=
# Viewport and mesh visualization

The viewport renders published resources; it does not infer scientific validity from visual
appearance.

Mesh-related layers may include:

- authored geometry surfaces;
- FDM grid bounds, active-cell support, and region membership;
- FEM volume and boundary elements;
- magnetic and nonmagnetic airbox parts;
- object and region partitions;
- mixed prism, pyramid, tetrahedron, or hexahedron families;
- quality-filtered element selections;
- periodic-pair and boundary-marker diagnostics.

A viewport layer must retain mesh-part and semantic-region identity so users can independently hide,
filter, and inspect airbox and magnetic objects. Renderer decimation or surface extraction is a
visualization policy and must not be presented as the solver mesh.

The authoritative element counts, topology, quality, and digest come from backend mesh resources and
reports.
