---
title: Interpolation and State Transfer
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-interpolation-and-state-transfer-root)=
# Interpolation and State Transfer

State transfer is a runtime continuation operation, not a new physical interaction. The source and
target discretizations remain explicit: FEM nodal fields are located and interpolated onto FDM cell
centers, while cross-mesh FEM continuation uses element location and P1 interpolation. The two
directions have separate failure and outside-domain semantics.

```{toctree}
:maxdepth: 1

fem-to-fdm
fdm-to-fem
```
