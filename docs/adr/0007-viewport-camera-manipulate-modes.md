# ADR 0007: Viewport Camera and Manipulate Are Exclusive Modes

| Field     | Value |
| --------- | ----- |
| Status    | Accepted |
| Date      | 2026-04-19 |
| Deciders  | Frontend team |
| Relates   | `apps/web/features/interaction/model/viewportInteraction.ts` |

## Context

The viewport currently handles camera orbit/pan/zoom and transform gizmo interaction in a single input model. This causes ambiguity when dragging near a gizmo handle — should the camera orbit or should the object move?

## Decision

The viewport has one active mode at a time:

```
ViewportMode = "camera" | "manipulate"
```

- **Camera mode**: all drag input controls the camera (orbit, pan, zoom). No gizmo is shown.
- **Manipulate mode**: an active transform tool (Move/Rotate/Scale) is shown. Drag on the gizmo transforms the target. Camera is controlled only via modifier keys or scroll.

Selecting a transform tool (W/E/R) automatically switches to Manipulate mode. Pressing `C` returns to Camera mode.

## Implementation

- `ViewportInteractionState.mode` holds the current mode.
- `setTransformTool("move"|"rotate"|"scale")` auto-switches mode to `"manipulate"`.
- `setViewportMode("camera")` hides the gizmo.
- The input router dispatches events based on the active mode.

## Consequences

**Positive:** Unambiguous input handling. Clear active-tool indication in the toolbar.

**Negative:** One extra keypress to switch between camera and manipulation. Mitigated by muscle memory (C/M shortcuts) and automatic mode switch when picking a tool.
