---
title: FEM Airbox Mesh Panel
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-airbox-mesh)=
# FEM Airbox Mesh Panel

The airbox panel edits the universe-owned exterior geometry and air-mesh policy. Its typed draft is
defined in `airboxMeshPolicyDraft.ts`; the UI is implemented by
`AirboxMeshParametersPanel.tsx`.

## Canonical controls

| UI field | Backend key | Unit |
|---|---|---|
| Domain mode | `mode` | 1 |
| Padding X/Y/Z | `padding` | m |
| Size X/Y/Z | `size` | m |
| Center X/Y/Z | `center` | m |
| Maximum / minimum element size | `airbox_hmax`, `airbox_hmin` | m |
| Maximum element growth rate | `airbox_growth_rate` | 1 |
| Element grading | `airbox_grading` | `auto`, `geometric`, `linear` |
| Curvature factor | `curvature_factor` | 1 |
| Narrow-region resolution | `narrow_region_resolution` | 1 |
| Advanced JSON | complete universe policy | mixed |

For FDM, FEM-only air-mesh keys are filtered; the panel exposes only structured-domain geometry.
For FEM, **Apply Airbox Policy** stores authored intent and makes the realized shared-domain mesh
stale. **Apply & Build Shared-Domain Mesh** then executes `mesh.build-shared-domain`.

The read-only effective section comes from backend `effective_config`; it must not be inferred from
the current text fields.
