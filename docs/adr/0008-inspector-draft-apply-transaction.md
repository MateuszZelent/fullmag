# ADR 0008: Inspector Edits a Draft — Apply Commits a Transaction

| Field     | Value |
| --------- | ----- |
| Status    | Accepted |
| Date      | 2026-04-19 |
| Deciders  | Frontend team |
| Relates   | `apps/web/features/interaction/inspector/ApplyBar.tsx`, `apps/web/features/interaction/model/sceneTransaction.ts` |

## Context

Inspector panels (Geometry, Material, Magnetization, Mesh) currently write changes directly to the scene document on every input event. This causes:

- Unwanted mesh invalidation from partial edits.
- No way to preview changes before committing.
- No undo granularity — each keystroke is a separate mutation.
- Difficulty distinguishing "user is still editing" from "user intends this change."

## Decision

Inspector panels edit a **draft** state. The draft is local to the inspector and does not modify the applied scene until the user clicks **Apply**.

- **Draft**: mutable working copy of the inspected entity's parameters.
- **Apply**: commits a `SceneTransaction` that patches the applied scene, bumps revision, and triggers the appropriate dirty-graph invalidation.
- **Revert**: discards the draft and reloads from the current applied scene.
- The `InspectorApplyBar` component shows status (Clean/Draft/Applying/Error) and provides Apply/Revert buttons.

## Implementation

- Each inspector panel maintains a draft via local state or a dedicated draft slice.
- `InspectorApplyBar` is a shared component across all inspector panels.
- On Apply, the panel creates a `SceneTransaction` with `kind`, `patch`, `baseRevision`, and `invalidates`.
- The transaction is processed by the authoring store, which updates the scene and dispatches dirty-graph actions.

## Consequences

**Positive:** Clean undo boundaries. Preview capability. No accidental invalidation from partial edits. Clear user intent.

**Negative:** Extra Apply click for every change. Mitigated by keyboard shortcut (Ctrl+Enter) and visual draft indicator.
