---
title: Frontend
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-root)=
# Frontend

This branch documents the browser application: what users can see, edit, submit, inspect, and
visualize. It does **not** redefine the Python API or backend numerical method.

Use the frontend reference for questions such as:

- which Explorer selection opens a particular Inspector panel;
- whether a field is authored, inherited, backend-effective, or read-only;
- what Apply, Revert, Build, and Apply & Build do;
- how stale mesh resources and completed build artifacts are presented;
- how FDM cells, FEM elements, airbox, regions, and quality distributions are visualized.

```{toctree}
:maxdepth: 4

control-room/index
viewport/index
workflows/index
```

## Ownership boundary

| Concern | Frontend owns | Canonical detailed owner |
|---|---|---|
| Form layout and labels | panels, controls, validation feedback, draft state | this branch |
| Python syntax and defaults | displayed round-trip examples only | {doc}`../python-api/index` |
| Numerical realization | requested/resolved status display only | {doc}`../backend/index` |
| Equations and physical units | links and contextual help | {doc}`../physics/index` |
| Scientific qualification | badges and evidence links | {doc}`../validation/index` |

Frontend resources are revisioned. Editing a policy does not mutate the currently materialized
solver mesh until the appropriate build command completes successfully.
