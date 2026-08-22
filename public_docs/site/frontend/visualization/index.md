---
title: Frontend Visualization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-visualization-root)=
# Frontend Visualization

Visualization consumes published geometry, mesh, field, and selection resources. It must distinguish
the authored CAD model, mesh preview, current solver mesh, magnetic submesh, airbox, and result
fields.

For meshing, the critical rule is that a rendered surface is not a topology certificate. The
viewport may hide internal interfaces, duplicate coincident faces, inverted elements, region-marker
loss, or unsupported mixed element families. Those facts come from backend reports and quality
resources.

FDM and FEM use separate render adapters but share the viewport and inspection model. FDM renders
structured cells/masks; FEM renders extracted vertices, cells, boundary subsets, and semantic mesh
parts.
