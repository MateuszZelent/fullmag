---
title: Boundary-Layer Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-boundary-layers)=
# Boundary-layer mesh API

Object recipes expose:

| Field | Unit | Meaning |
|---|---:|---|
| `boundary_layer_count` | 1 | number of generated layers |
| `boundary_layer_thickness` | m | total layer-stack thickness |
| `boundary_layer_stretching` | 1 | growth ratio between consecutive layers |
| surface/curve selectors | 1 | semantic target definitions |
| surface/curve tags | 1 | advanced raw Gmsh target IDs |

An ordered operation can also be represented as:

```text
fm.MeshOperation(
    kind="boundary_layers",
    params={...},
    enabled=True,
)
```

Selector resolution occurs during geometry/mesh construction. A syntactically valid policy can
still fail because the selected entity is absent, ambiguous, lost through fallback, or incompatible
with the requested transition topology.
