"use client";

import {
  events as createPointerEvents,
  type EventManager,
  type Events,
} from "@react-three/fiber";

const VIEWPORT_3D_EVENT_HANDLER_KEYS = [
  "onClick",
  "onPointerDown",
  "onPointerMove",
  "onPointerLeave",
  "onPointerCancel",
  "onLostPointerCapture",
  "onWheel",
] as const satisfies readonly (keyof Events)[];
const VIEWPORT_3D_IMMEDIATE_POINTER_DOWN_REGION_PX = 240;
const VIEWPORT_3D_STATIC_CLICK_DELTA_PX = 2;

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

function viewport3DEventOffset(event: Event): [number, number] {
  const mouseEvent = event as MouseEvent;
  return [
    typeof mouseEvent.offsetX === "number" ? mouseEvent.offsetX : 0,
    typeof mouseEvent.offsetY === "number" ? mouseEvent.offsetY : 0,
  ];
}

function viewport3DClickDelta(
  store: Parameters<typeof createPointerEvents>[0],
  event: Event,
): number {
  const [offsetX, offsetY] = viewport3DEventOffset(event);
  const [initialX, initialY] = store.getState().internal.initialClick;
  const dx = offsetX - initialX;
  const dy = offsetY - initialY;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

export function isViewport3DImmediatePointerDownRegion(event: Event): boolean {
  const mouseEvent = event as MouseEvent;
  const target = mouseEvent.currentTarget as Partial<HTMLElement> | null;
  if (typeof target?.clientWidth !== "number") return false;
  const [offsetX, offsetY] = viewport3DEventOffset(event);
  return (
    offsetX >= target.clientWidth - VIEWPORT_3D_IMMEDIATE_POINTER_DOWN_REGION_PX &&
    offsetY <= VIEWPORT_3D_IMMEDIATE_POINTER_DOWN_REGION_PX
  );
}

export function createViewport3DPointerDownHandler(
  store: Parameters<typeof createPointerEvents>[0],
  pointerDownHandler?: EventListener,
): EventListener {
  return (event) => {
    if (pointerDownHandler && isViewport3DImmediatePointerDownRegion(event)) {
      pointerDownHandler(event);
      return;
    }

    const state = store.getState();
    state.internal.initialClick = viewport3DEventOffset(event);
    state.internal.initialHits = [];
  };
}

export function createViewport3DClickSelectionHandler({
  clickHandler,
  pointerDownHandler,
  store,
}: {
  clickHandler?: EventListener;
  pointerDownHandler?: EventListener;
  store: Parameters<typeof createPointerEvents>[0];
}): EventListener {
  return (event) => {
    if (viewport3DClickDelta(store, event) > VIEWPORT_3D_STATIC_CLICK_DELTA_PX) {
      return;
    }

    pointerDownHandler?.(event);
    if (store.getState().internal.initialHits.length > 0) return;
    clickHandler?.(event);
  };
}

export function createViewport3DPointerMoveHandler(
  handler: EventListener | undefined,
): EventListener | undefined {
  if (!handler) return undefined;

  return (event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.buttons !== 0) return;
    handler(event);
  };
}

export function createViewport3DEventManager(
  store: Parameters<typeof createPointerEvents>[0],
): EventManager<HTMLElement> {
  const manager = createPointerEvents(store);
  const pickedHandlers = pickViewport3DEventHandlers(manager.handlers);
  return {
    ...manager,
    handlers: {
      ...pickedHandlers,
      onClick: createViewport3DClickSelectionHandler({
        clickHandler: pickedHandlers?.onClick,
        pointerDownHandler: pickedHandlers?.onPointerDown,
        store,
      }),
      onPointerDown: createViewport3DPointerDownHandler(
        store,
        pickedHandlers?.onPointerDown,
      ),
      onPointerMove: createViewport3DPointerMoveHandler(
        pickedHandlers?.onPointerMove,
      ),
      onWheel: () => {
        // Native wheel event is allowed to propagate for camera controls, but we
        // bypass R3F's internal raycasting/event-handling on scroll to avoid lag.
      },
    } as Events,
  };
}
