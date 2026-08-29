---
title: Mesh Build Lifecycle
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-build-lifecycle)=
# Mesh Build Lifecycle

The UI treats policy editing and mesh construction as separate transactions.

```text
clean authored policy
      │ edit
      ▼
dirty draft
      │ Apply
      ▼
new policy revision ──► current mesh becomes stale
      │ Build
      ▼
requested/running build
      ├─ failure ─► failed current build; latest-successful mesh remains available
      └─ success ─► new current and latest-successful mesh resources
```

## Commands and resource invalidation

| Action | Command/resource consequence |
|---|---|
| Apply object policy | replaces object config; invalidates object report/quality, mesh build, and scene |
| Apply airbox policy | replaces universe config; invalidates current/latest mesh build |
| Build selected object | `mesh.build-selected` |
| Build shared domain | `mesh.build-shared-domain` |
| Geometry edit | invalidates every mesh derived from the previous geometry digest |
| Revert | discards only the local draft; it does not roll back a committed backend revision |

A success banner means the request was accepted, not that meshing completed. Completion and
qualification come from build/report resources.
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

