---
title: FEM Mesh Controls
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-fem-root)=
# FEM mesh controls

FEM policy is split by its physical and lifecycle owner. Object mesh, airbox mesh, region
refinement, and the build/quality workflow are independent resources and panels.

```{toctree}
:maxdepth: 2

object-mesh
airbox-mesh
region-mesh
build-and-quality
```

| Page | Editable owner |
|---|---|
| Object mesh | selected magnetic object's bulk and local mesh recipe |
| Airbox mesh | universe-owned exterior geometry and air size policy |
| Region mesh | selected region's local override |
| Build and quality | commands and read-only realized reports |

Editing one scope does not implicitly rewrite the others. The final shared-domain build resolves all
active scopes into one conforming mesh.
