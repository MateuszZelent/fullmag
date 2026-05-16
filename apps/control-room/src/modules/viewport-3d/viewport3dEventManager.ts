"use client";

import {
  events as createPointerEvents,
  type EventManager,
  type Events,
} from "@react-three/fiber";

const VIEWPORT_3D_EVENT_HANDLER_KEYS = [
  "onPointerDown",
  "onPointerMove",
  "onPointerLeave",
  "onPointerCancel",
  "onLostPointerCapture",
  "onWheel",
] as const satisfies readonly (keyof Events)[];

export function pickViewport3DEventHandlers(
  handlers: EventManager<HTMLElement>["handlers"],
): EventManager<HTMLElement>["handlers"] {
  if (!handlers) return handlers;

  const next: Partial<Events> = {};
  for (const key of VIEWPORT_3D_EVENT_HANDLER_KEYS) {
    const handler = handlers[key];
    if (handler) {
      next[key] = handler;
    }
  }
  return next as Events;
}

export function createViewport3DMissedClickHandler(
  store: Parameters<typeof createPointerEvents>[0],
): EventListener {
  return (event) => {
    const state = store.getState();
    const mouseEvent = event as MouseEvent;
    const [initialX, initialY] = state.internal.initialClick;
    const dx = mouseEvent.offsetX - initialX;
    const dy = mouseEvent.offsetY - initialY;
    const delta = Math.round(Math.sqrt(dx * dx + dy * dy));

    if (delta > 2 || state.internal.initialHits.length > 0) return;
    state.onPointerMissed?.(mouseEvent);
  };
}

export function createViewport3DEventManager(
  store: Parameters<typeof createPointerEvents>[0],
): EventManager<HTMLElement> {
  const manager = createPointerEvents(store);
  return {
    ...manager,
    handlers: {
      ...pickViewport3DEventHandlers(manager.handlers),
      onClick: createViewport3DMissedClickHandler(store),
    } as Events,
  };
}
