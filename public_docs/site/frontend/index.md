---
title: Frontend
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-root)=
# Frontend

The Frontend branch documents the browser Control Room as a client of the canonical FullMag
resources and commands. It does not redefine solver physics or claim that a displayed preview is the
solver mesh.

Use this branch for:

- Explorer and Inspector navigation;
- draft editing, Apply/Revert transactions, and stale-resource semantics;
- FEM object, airbox, and region mesh panels;
- FDM read-only structured-grid inspection;
- mesh build commands, progress resources, quality reports, and viewport feedback;
- Python round-trip and authored-versus-effective values.

Backend algorithms are documented under {doc}`../backend/index`; Python constructors and parameters
under {doc}`../python-api/index`.

```{toctree}
:maxdepth: 3

control-room/index
meshing/index
visualization/index
state-and-commands/index
```
