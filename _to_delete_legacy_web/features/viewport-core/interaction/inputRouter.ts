/**
 * Layer D: Input Router
 *
 * Pure function that decides what the next InteractionMode should be
 * given the current mode + an incoming input event.
 * No side-effects — the viewport loop calls this on every pointer event
 * and feeds the result into useViewportStore.setInteractionMode().
 */

import type { InteractionMode } from "./interactionMode.types";

export type InputEvent =
  | { type: "pointer-down"; button: number; shiftKey: boolean; ctrlKey: boolean }
  | { type: "pointer-up"; button: number }
  | { type: "pointer-move"; dx: number; dy: number }
  | { type: "gizmo-start"; axis: "x" | "y" | "z" }
  | { type: "gizmo-end" }
  | { type: "key-down"; key: string }
  | { type: "key-up"; key: string }
  | { type: "escape" }
  | { type: "focus-lost" };

export interface InputRouterResult {
  nextMode: InteractionMode;
  consumed: boolean;
}

/**
 * Determine the next interaction mode given the current mode and an input event.
 */
export function routeInput(
  currentMode: InteractionMode,
  event: InputEvent,
): InputRouterResult {
  if (currentMode === "disabled") {
    return { nextMode: "disabled", consumed: false };
  }

  switch (event.type) {
    case "escape":
      return { nextMode: "camera-navigate", consumed: true };

    case "focus-lost":
      return { nextMode: "camera-navigate", consumed: false };

    case "gizmo-start":
      return {
        nextMode:
          currentMode === "gizmo-rotate"
            ? "gizmo-rotate"
            : currentMode === "gizmo-scale"
              ? "gizmo-scale"
              : "gizmo-translate",
        consumed: true,
      };

    case "gizmo-end":
      return { nextMode: "camera-navigate", consumed: true };

    case "pointer-down": {
      // Middle mouse / right-click → pan / orbit (camera-navigate)
      if (event.button === 1 || event.button === 2) {
        return { nextMode: "camera-navigate", consumed: false };
      }
      // Left-click: context-dependent
      if (event.button === 0) {
        if (event.shiftKey) {
          return { nextMode: "lasso-select", consumed: true };
        }
        if (
          currentMode === "gizmo-translate" ||
          currentMode === "gizmo-rotate" ||
          currentMode === "gizmo-scale"
        ) {
          return { nextMode: currentMode, consumed: false };
        }
        return { nextMode: "selection-click", consumed: true };
      }
      return { nextMode: currentMode, consumed: false };
    }

    case "pointer-up": {
      if (
        currentMode === "selection-click" ||
        currentMode === "lasso-select"
      ) {
        return { nextMode: "camera-navigate", consumed: true };
      }
      return { nextMode: currentMode, consumed: false };
    }

    case "pointer-move": {
      // During selection drag, stay in current mode
      if (
        currentMode === "lasso-select" ||
        currentMode === "gizmo-translate" ||
        currentMode === "gizmo-rotate" ||
        currentMode === "gizmo-scale"
      ) {
        return { nextMode: currentMode, consumed: true };
      }
      return { nextMode: "selection-hover", consumed: false };
    }

    case "key-down": {
      switch (event.key) {
        case "g":
          return { nextMode: "gizmo-translate", consumed: true };
        case "r":
          return { nextMode: "gizmo-rotate", consumed: true };
        case "s":
          return { nextMode: "gizmo-scale", consumed: true };
        default:
          return { nextMode: currentMode, consumed: false };
      }
    }

    case "key-up":
      return { nextMode: currentMode, consumed: false };

    default:
      return { nextMode: currentMode, consumed: false };
  }
}
