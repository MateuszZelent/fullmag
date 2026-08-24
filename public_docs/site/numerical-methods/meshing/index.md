---
title: Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-root)=
# Meshing

Meshing converts authored geometry and policy into the discrete spatial asset consumed by the
backend. FDM and FEM are separate branches because they use different spaces, topology, ownership,
and failure semantics.

| Branch | State location | Geometry realization | Primary nonlocal method |
|---|---|---|---|
| FDM | cell centres | Cartesian allocation plus masks/fractions | Newell tensor convolution |
| FEM | finite-element degrees of freedom | conforming shared-domain elements | Poisson airbox or FEM/BEM |

For both branches, requested policy and realized mesh/grid provenance are retained separately.

```{toctree}
:maxdepth: 4

fdm/index
fem/index
refinement
```
