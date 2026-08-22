---
title: Airbox Geometry API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-geometry)=
# Airbox geometry API

The stage-first authoring surface is:

```text
study.universe(mode="auto" or "manual", size=(Lx, Ly, Lz), center=(cx, cy, cz))
```

The canonical universe resource can also carry per-axis `padding`. Relevant fields are:

| Field | Unit | Contract |
|---|---:|---|
| `mode` | 1 | inherited, `auto`, or `manual` according to the public facade |
| `padding` | m | finite three-vector resolved around magnetic bounds |
| `size` | m | explicit three-vector for manual exterior dimensions |
| `center` | m | explicit exterior-domain centre |
| internal airbox shape | 1 | `bbox` or `sphere` where exposed by the generation schema |

Explicit dimensions must contain every magnetic body with valid clearance. Shape, bounds, and
clearances are confirmed by the realized report, not inferred from the request alone.
