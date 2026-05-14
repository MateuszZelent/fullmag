import { describe, expect, it, vi } from "vitest";

import {
  createViewport3DMissedClickHandler,
  pickViewport3DEventHandlers,
} from "./viewport3dEventManager";

describe("pickViewport3DEventHandlers", () => {
  it("removes release and click handlers from the heavy 3D scene event manager", () => {
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
      "onLostPointerCapture",
      "onPointerCancel",
      "onPointerDown",
      "onPointerLeave",
      "onPointerMove",
    ]);
  });

  it("keeps background click clearing without replaying R3F release raycasts", () => {
    const onPointerMissed = vi.fn();
    const store = ({
      getState: () => ({
        internal: {
          initialClick: [10, 20],
          initialHits: [],
        },
        onPointerMissed,
      }),
    } as unknown) as Parameters<typeof createViewport3DMissedClickHandler>[0];
    const handler = createViewport3DMissedClickHandler(store);

    handler({ offsetX: 11, offsetY: 21 } as MouseEvent);

    expect(onPointerMissed).toHaveBeenCalledTimes(1);
  });

  it("does not clear selection when the pointer down hit a selectable object", () => {
    const onPointerMissed = vi.fn();
    const store = ({
      getState: () => ({
        internal: {
          initialClick: [10, 20],
          initialHits: [{}],
        },
        onPointerMissed,
      }),
    } as unknown) as Parameters<typeof createViewport3DMissedClickHandler>[0];
    const handler = createViewport3DMissedClickHandler(store);

    handler({ offsetX: 11, offsetY: 21 } as MouseEvent);

    expect(onPointerMissed).not.toHaveBeenCalled();
  });
});
