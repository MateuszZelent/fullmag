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
| Curvature factor | `airbox_curvature_factor` (alias `curvature_factor`) | 1 |
| Narrow-region resolution | `airbox_narrow_region_resolution` (alias `narrow_region_resolution`) | 1 |
| Advanced JSON | complete universe policy | mixed |

Curvature factor and narrow-region resolution refine only the air (next to curved magnet
surfaces and across narrow air gaps) and require the maximum element size. They are
exported to Python as `study.universe.mesh(curvature_factor=..., narrow_region_resolution=...)`.
Exact-layer, swept and mixed air routes reject them.

For FDM, FEM-only air-mesh keys are filtered; the panel exposes only structured-domain geometry.
For FEM, **Apply Airbox Policy** stores authored intent and makes the realized shared-domain mesh
stale. **Apply & Build Shared-Domain Mesh** then executes `mesh.build-shared-domain`.

The read-only effective section comes from backend `effective_config`; it must not be inferred from
the current text fields.

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Airbox Mesh Overview inspector showing policy and manifest revision 4 match, carrier part_airbox, element size limits, and build growth rate
:align: center
:width: 100%
```

```{image} /_static/images/ui/viewport-3d-fem-mesh-airbox.png
:alt: 3D Viewport showing exterior airbox domain wireframe framing the FEM object geometry
:align: center
:width: 100%
```

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` | `AirboxMeshParametersPanel` | Controls and explicit Apply/build transaction |
| `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts` | `buildAirboxMeshPolicyReplaceRequest` | Typed/JSON policy merge and FDM filtering |
