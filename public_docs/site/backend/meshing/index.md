---
title: Backend Meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-root)=
# Backend meshing

FDM and FEM use different spatial models and therefore different implementation branches.

```{toctree}
:maxdepth: 4

fdm/index
fem/index
state-transfer
```

| Branch | State space | Geometry realization | Nonlocal-field mesh |
|---|---|---|---|
| FDM | cell-centred Cartesian vectors | rectangular allocation plus active/material masks | padded or common FFT grid |
| FEM | finite-element degrees of freedom | conforming elements and semantic attributes | shared airbox mesh or boundary operator |

The mesh or grid is part of the numerical problem. Every grid-dependent kernel, sparse operator,
periodic map, state-transfer operator, cache key, and result artifact must bind to the realized
spatial identity.
