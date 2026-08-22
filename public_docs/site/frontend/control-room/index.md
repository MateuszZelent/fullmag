---
title: Control Room
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-root)=
# Control Room

Control Room is the browser authoring and inspection client. It operates on revisioned backend
resources and explicit commands; it is not a second, independent simulation model.

```{toctree}
:maxdepth: 3

model-tree
inspector
meshing/index
```

## Interaction model

1. Explorer selection resolves a semantic object, region, airbox, interaction, stage, or output.
2. Inspector loads the corresponding authored policy and backend-effective resources.
3. Edits remain in a local draft until Apply or Apply & Build is invoked.
4. Applying a geometry or mesh policy invalidates the current mesh realization.
5. A build command creates a new revisioned mesh report and quality resource.
6. The viewport and diagnostics consume completed resources, never unsaved form state.

The corresponding source owners are under `apps/control-room/src/modules`, with data access and
revision invalidation under `apps/control-room/src/kernel/resources`.
