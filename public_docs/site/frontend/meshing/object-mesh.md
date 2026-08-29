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
`ObjectMeshPolicyPanel.tsx` and canonicalized by
`ObjectMeshPolicyPanelModel.ts`.

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
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

