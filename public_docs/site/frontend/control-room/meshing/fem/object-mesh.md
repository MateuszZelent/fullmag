---
title: Ferromagnet Mesh Panel
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-fem-object-mesh)=
# Ferromagnet mesh panel

The selected-object panel edits one `PerObjectMeshRecipe`-like policy. Its groups are intentionally
separate:

## Mesh-size presets

- calibration family;
- named size preset;
- multiplicative size factor.

## Element-size parameters

- maximum and minimum element size;
- maximum growth rate;
- curvature factor and Gmsh curvature sizing;
- narrow-region controls;
- finite-element order;
- optional imported mesh source.

## Thin-film strategy

The strategy selector distinguishes inherited, free tetrahedral, and exact layered prism. Swept hex
is visible only as unsupported until the capability resource advertises an executable scope. Exact
prism selection canonicalizes the required topology, P1 order, triangular source faces, fixed layer
distribution, exact layer count, and pyramid-to-tetrahedron transition.

## Local refinement and backend parameters

The panel also owns interface, edge, corner, manual box, core-relaxation, boundary-layer, Gmsh
algorithm, smoothing, optimizer, and quality-output controls. Raw tags are accepted only as an
advanced mechanism; semantic selectors are preferred because tags may change after geometry rebuild.

Applying the policy marks the solver mesh stale. Building is a separate command.
