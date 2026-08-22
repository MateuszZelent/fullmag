---
title: FDM Grid Inspector
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-fdm)=
# FDM grid inspector

For an FDM session, Control Room presents the resolved structured grid rather than FEM policy
controls. The inspector reports, when materialized:

- grid origin and SI spacing;
- integer grid shape and total cell count;
- active and inactive magnetic-cell counts;
- canonical mask or descriptor-only participation state;
- object and region membership metadata;
- grid fingerprint used for cache and provenance identity.

FDM mesh fields are read-only because the executable grid is owned by the planned study. To change
cell size, edit the Python/API authoring policy and re-plan or rerun the study. FEM build commands are
not offered in this lane.

Implementation anchors:

- `ObjectMeshPolicyPanel.tsx` — lane dispatch and selected-object display;
- `fdmMeshInspectorModel.ts` — normalized FDM resource model;
- `ObjectRegionMeshPanel.tsx` — region cell-membership view.
