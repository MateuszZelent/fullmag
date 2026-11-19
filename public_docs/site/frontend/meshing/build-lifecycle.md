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

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts` | `GEOMETRY_LIFECYCLE_COMMANDS` | Registered build actions and lane gates |
| `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `ObjectMeshPolicyPanel` | Apply and invalidation |
