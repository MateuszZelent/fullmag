---
title: Boundary-Layer Meshes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-boundary-layers)=
# Boundary-layer meshes

Boundary-layer operations generate anisotropic layers normal to selected surfaces or curves. They
are distinct from a full thin-film sweep: only selected boundary neighbourhoods are layered.

The request specifies layer count, total thickness, stretching ratio, and semantic selectors or raw
Gmsh tags. The backend resolves selectors after CAD construction and records requested, resolved,
empty, ambiguous, or degraded status.

Scientific and topological checks include:

- positive layer thickness and monotone cumulative distance;
- valid normals and absence of self-intersection;
- compatibility at corners and selector boundaries;
- transition conformity with the interior volume mesh;
- positive Jacobians and acceptable aspect/warpage statistics;
- proof that the requested entities retained identity through fallback.

Raw tags are fragile because Boolean fragmentation can renumber entities. Semantic selectors are the
preferred reproducible contract.
