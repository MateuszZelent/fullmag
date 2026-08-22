---
title: Meshing In Control Room
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-root)=
# Meshing in Control Room

The UI first resolves the active spatial lane. FDM and FEM then expose different semantics rather
than sharing one generic mesh form.

```{toctree}
:maxdepth: 3

fdm
fem/index
```

| Lane | Frontend contract |
|---|---|
| FDM | structured grid and region membership are execution-plan-owned and shown read-only |
| FEM | object, region, and airbox policy can be authored; realized topology and quality are separate read-only resources |
| unresolved | write actions are withheld until the session declares FDM or FEM |

The UI never translates an FDM cell-size edit into an FEM element-size edit or vice versa.
