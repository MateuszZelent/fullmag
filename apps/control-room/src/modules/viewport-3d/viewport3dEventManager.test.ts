import { describe, expect, it, vi } from "vitest";

import {
  createViewport3DClickSelectionHandler,
  createViewport3DPointerMoveHandler,
  createViewport3DPointerDownHandler,
  isViewport3DImmediatePointerDownRegion,
  pickViewport3DEventHandlers,
} from "./viewport3dEventManager";

describe("pickViewport3DEventHandlers", () => {
  it("removes release handlers but keeps click selection and wheel zoom", () => {
    const handlers = {
      onClick: vi.fn(),
      onContextMenu: vi.fn(),
      onDoubleClick: vi.fn(),
      onLostPointerCapture: vi.fn(),
      onPointerCancel: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerLeave: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      onWheel: vi.fn(),
    };

    expect(Object.keys(pickViewport3DEventHandlers(handlers) ?? {}).sort()).toEqual([
      "onClick",
      "onLostPointerCapture",
      "onPointerCancel",
      "onPointerDown",
      "onPointerLeave",
      "onPointerMove",
      "onWheel",
    ]);
  });

  it("records click origin without running the expensive R3F pointer-down handler", () => {
    const state = {
      internal: {
        initialClick: [0, 0],
        initialHits: [{}],
      },
    };
    const store = ({
      getState: () => state,
    } as unknown) as Parameters<typeof createViewport3DPointerDownHandler>[0];
    const handler = createViewport3DPointerDownHandler(store);

    handler({ offsetX: 10, offsetY: 20 } as MouseEvent);

    expect(state.internal.initialClick).toEqual([10, 20]);
    expect(state.internal.initialHits).toEqual([]);
  });

  it("replays R3F pointer-down and click only for static selection clicks", () => {
    const state = {
      internal: {
        initialClick: [10, 20],
        initialHits: [] as unknown[],
      },
    };
    const store = ({
      getState: () => state,
    } as unknown) as Parameters<typeof createViewport3DClickSelectionHandler>[0]["store"];
    const pointerDownHandler = vi.fn();
    const clickHandler = vi.fn();
    const handler = createViewport3DClickSelectionHandler({
      clickHandler,
      pointerDownHandler,
      store,
    });

    handler({ offsetX: 11, offsetY: 21 } as MouseEvent);

    expect(pointerDownHandler).toHaveBeenCalledTimes(1);
    expect(clickHandler).toHaveBeenCalledTimes(1);
  });

  it("does not run a second click raycast after pointer-down selection hit", () => {
    const state = {
      internal: {
        initialClick: [10, 20],
        initialHits: [] as unknown[],
      },
    };
    const store = ({
      getState: () => state,
    } as unknown) as Parameters<typeof createViewport3DClickSelectionHandler>[0]["store"];
    const pointerDownHandler = vi.fn(() => {
      state.internal.initialHits = [{}];
    });
    const clickHandler = vi.fn();
    const handler = createViewport3DClickSelectionHandler({
      clickHandler,
      pointerDownHandler,
      store,
    });

    handler({ offsetX: 11, offsetY: 21 } as MouseEvent);

    expect(pointerDownHandler).toHaveBeenCalledTimes(1);
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it("keeps immediate pointer-down handling for the ViewCube HUD region", () => {
    const event = {
      currentTarget: {
        clientHeight: 600,
        clientWidth: 800,
      },
      offsetX: 720,
      offsetY: 80,
    } as unknown as MouseEvent;

    expect(isViewport3DImmediatePointerDownRegion(event)).toBe(true);
  });

  it("blocks native camera controls after dispatching ViewCube HUD pointer-down", () => {
    const state = {
      internal: {
        initialClick: [0, 0],
        initialHits: [] as unknown[],
      },
    };
    const store = ({
      getState: () => state,
    } as unknown) as Parameters<typeof createViewport3DPointerDownHandler>[0];
    const pointerDownHandler = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const preventDefault = vi.fn();
    const handler = createViewport3DPointerDownHandler(store, pointerDownHandler);

    handler({
      currentTarget: {
        clientHeight: 600,
        clientWidth: 800,
      },
      offsetX: 720,
      offsetY: 80,
      preventDefault,
      stopImmediatePropagation,
    } as unknown as MouseEvent);

    expect(pointerDownHandler).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("does not replay selection raycasts for camera drags", () => {
    const store = ({
      getState: () => ({
        internal: {
          initialClick: [10, 20],
          initialHits: [] as unknown[],
        },
      }),
    } as unknown) as Parameters<typeof createViewport3DClickSelectionHandler>[0]["store"];
    const pointerDownHandler = vi.fn();
    const clickHandler = vi.fn();
    const handler = createViewport3DClickSelectionHandler({
      clickHandler,
      pointerDownHandler,
      store,
    });

    handler({ offsetX: 40, offsetY: 60 } as MouseEvent);

    expect(pointerDownHandler).not.toHaveBeenCalled();
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it("skips pointer-move raycasts while camera drag buttons are pressed", () => {
    const innerHandler = vi.fn();
    const handler = createViewport3DPointerMoveHandler(innerHandler);

    handler?.({ buttons: 1 } as PointerEvent);
    handler?.({ buttons: 2 } as PointerEvent);
    handler?.({ buttons: 4 } as PointerEvent);

    expect(innerHandler).not.toHaveBeenCalled();
  });

  it("keeps passive pointer-move handling for hover interactions", () => {
    const innerHandler = vi.fn();
    const handler = createViewport3DPointerMoveHandler(innerHandler);
    const event = { buttons: 0 } as PointerEvent;

    handler?.(event);

    expect(innerHandler).toHaveBeenCalledWith(event);
  });
});
