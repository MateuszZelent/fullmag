---
title: Model Tree
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-model-tree)=
# Model Tree

The Explorer tree presents semantic simulation ownership rather than filesystem or renderer
hierarchy. Typical nodes are:

- universe and airbox;
- magnetic objects;
- object-owned regions;
- material and initial-texture assignments;
- interactions and couplings;
- mesh policy, current realization, quality, and build history;
- ordered stages and output requests.

## Selection rules

| Selection | Primary Inspector responsibility |
|---|---|
| universe or airbox | exterior geometry, airbox mesh policy, effective values, build action |
| magnetic object | material, texture, object mesh policy, object report and quality |
| object region | region geometry/material/texture override and region mesh policy |
| FDM object/region | read-only structured-grid descriptor and cell membership |
| FEM mesh artifact | realized topology, attributes, quality, provenance and stale status |

A selection ID is stable semantic identity. Gmsh entity tags, element indices, and Three.js object IDs
are implementation details and must not replace it in authored requests.
