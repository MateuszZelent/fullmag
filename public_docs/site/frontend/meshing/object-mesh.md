---
title: FEM Object Mesh Panel
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-object-mesh)=
# FEM Object Mesh Panel

The object panel edits one object-owned mesh policy. It is implemented by
`ObjectMeshInspectorSpecPanel` (`ObjectMeshSpecPanel.tsx`) and canonicalized by
`ObjectMeshPolicyPanelModel.ts`, complementing global study sizing in `MeshRootInspectorSpecPanel`
(`MeshRootSpec.tsx`).

## Panel groups

| UI group | Main keys |
|---|---|
| Mesh Size Presets | `calibrate_for`, `size_preset`, `size_factor` |
| Element Size Parameters | `maximum_element_size`, `minimum_element_size`, growth, curvature, narrow regions, `order`, `source` |
| Thin-Film Sweep Strategy | `mesh_strategy`, layer count, source/destination selectors, topology, transition |
| Interface and Transition Refinement | interface size/thickness, transition distance and growth |
| Backend Mesh Parameters | Gmsh algorithms, smoothing, optimizer, boundary layers, quality |
| Core Relaxation | object-local size-field relaxation from surfaces/edges to the core |
| Manual Size Field | explicit box size field |
| Edge and Corner Refinement | local edge/corner targets and ramps |
| Advanced JSON | complete canonical object-policy payload |
| Quality / History tabs | realized report, quality distributions, raw resources |

Selecting `swept_prism` canonicalizes the supported exact layered-prism fields: P1 order,
triangular source faces, fixed distribution, exact layer count, prism family, and
`pyramid_to_tetrahedra` transition. The current Control Room gate accepts only the layer counts
advertised by `mesh.exact_layer_count`; unsupported `swept_hex` remains disabled.

**Apply Object Policy** writes the policy and invalidates current mesh resources. **Build Mesh**
executes `mesh.build-selected`; if the draft is dirty, the panel applies it first.

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Airbox Mesh Overview inspector displaying FEM readiness badges, topology revision match, carrier part_airbox, and element size targets
:align: center
:width: 100%
```

```{image} /_static/images/ui/viewport-3d-fem-mesh-airbox.png
:alt: 3D Viewport rendering FEM object geometry enclosed by the exterior airbox wireframe
:align: center
:width: 100%
```

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx` | `ObjectMeshInspectorSpecPanel` | Object policy read/write and resource invalidation |
| `apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx` | `MeshRootInspectorSpecPanel` | Study-level FEM default sizing and shared-domain build triggers |
| `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` | Canonical replacement payload |
