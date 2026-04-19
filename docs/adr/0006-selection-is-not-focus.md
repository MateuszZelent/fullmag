# ADR 0006: Selection Is Not Camera Focus

| Field     | Value |
| --------- | ----- |
| Status    | Accepted |
| Date      | 2026-04-19 |
| Deciders  | Frontend team |
| Relates   | `apps/web/features/interaction/model/selection.ts`, `apps/web/features/interaction/model/cameraCommand.ts` |

## Context

Clicking a node in the Model Tree or an object in the Viewport currently conflates two distinct operations: *selecting* a target (highlight, inspector context, ribbon context) and *focusing* the camera on that target. This leads to unpredictable camera jumps, especially when the user is inspecting multiple objects sequentially from a fixed viewpoint.

Professional 3D tools (Blender, 3ds Max, COMSOL) treat selection and camera focus as independent operations.

## Decision

- `select(target)` changes only selection state: highlight, inspector panel, ribbon context, and active workspace route. It **never** moves the camera.
- Camera movement is an explicit command: `focusTarget`, `focusSelection`, `fitAll`, `viewAxis`.
- The `F` keyboard shortcut triggers `focusSelection` (focus camera on current selection).
- Double-click in the tree triggers select + focus as a convenience.
- Context menu offers "Focus in 3D" as an explicit action.

## Implementation

- `useInteractionStore.select()` updates `SelectionState` only.
- `useInteractionStore.focusTarget()` dispatches a `CameraCommand`.
- Camera commands are consumed by the viewport camera controller, not by the selection logic.

## Consequences

**Positive:** Predictable camera behavior. Users can browse the tree without losing their viewport setup.

**Negative:** Users accustomed to auto-focus on click need to learn `F` or double-click. The Focus command must be discoverable (toolbar, context menu, shortcut hint).
