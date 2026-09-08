import { act, StrictMode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

function createLifecycleTestGlStub(order?: string[]) {
  return {
    dispose: vi.fn(() => order?.push("dispose")),
    forceContextLoss: vi.fn(() => order?.push("forceContextLoss")),
    renderLists: { dispose: vi.fn(() => order?.push("renderLists")) },
  };
}

const fiber = vi.hoisted(() => {
  const configurations: Array<{
    onCreated?: (state: unknown) => void;
  }> = [];
  const renders: unknown[] = [];
  const roots: Array<{
    events: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    unmount: ReturnType<typeof vi.fn>;
  }> = [];
  const resolvers: Array<() => void> = [];
  // Populated per-test (see createLifecycleTestGlStub) so the M-07 cleanup
  // tests can assert on renderer.dispose()/forceContextLoss() without every
  // other test in this file needing to know about `gl`.
  let glStub: unknown = null;
  return {
    configurations,
    getGlStub: () => glStub,
    renders,
    resolvers,
    roots,
    setGlStub: (stub: unknown) => {
      glStub = stub;
    },
  };
});

vi.mock("@react-three/fiber", () => ({
  createRoot: vi.fn(() => {
    const events = { connect: vi.fn(), disconnect: vi.fn() };
    const root = {
      configure: vi.fn((configuration) => {
        fiber.configurations.push(configuration);
        configuration.onCreated?.({
          events,
          gl: fiber.getGlStub(),
          setEvents: vi.fn(),
        });
        return new Promise((resolve) => {
          fiber.resolvers.push(() => resolve(root));
        });
      }),
      render: vi.fn((scene) => fiber.renders.push(scene)),
      unmount: vi.fn(),
    };
    fiber.roots.push({ events, unmount: root.unmount });
    return root;
  }),
  extend: vi.fn(),
}));

import { Viewport3DCanvas } from "./Viewport3DCanvas";

describe("Viewport3DCanvas strict lifecycle", () => {
  it("tears down every StrictMode root, bounds configure churn, and ignores late completion", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const htmlElement = globalThis.HTMLElement as unknown as {
      prototype: { getBoundingClientRect: () => DOMRect };
    };
    const originalRect = htmlElement.prototype.getBoundingClientRect;
    htmlElement.prototype.getBoundingClientRect = () =>
      ({ height: 240, width: 320 }) as DOMRect;
    const originalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() { this.callback([], this as unknown as ResizeObserver); }
      unobserve() {}
    } as typeof ResizeObserver;
    const root = createReactRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Viewport3DCanvas dpr={1} frameloop="demand"><group /></Viewport3DCanvas>
          </StrictMode>,
        );
      });
      const configureCountBeforeDprChange = fiber.configurations.length;
      await act(async () => {
        root.render(
          <StrictMode>
            <Viewport3DCanvas dpr={2} frameloop="demand"><group /></Viewport3DCanvas>
          </StrictMode>,
        );
      });
      expect(fiber.configurations).toHaveLength(configureCountBeforeDprChange + 1);
      await act(async () => root.unmount());
      await act(async () => {
        fiber.resolvers.splice(0).forEach((resolve) => resolve());
      });

      expect(fiber.roots.length).toBeGreaterThan(0);
      expect(fiber.roots.every((entry) => entry.unmount.mock.calls.length === 1)).toBe(true);
      expect(fiber.roots.every((entry) => entry.events.connect.mock.calls.length === 1)).toBe(true);
      expect(fiber.roots.every((entry) => entry.events.disconnect.mock.calls.length === 1)).toBe(true);
      expect(fiber.renders).toHaveLength(0);
    } finally {
      htmlElement.prototype.getBoundingClientRect = originalRect;
      globalThis.ResizeObserver = originalObserver;
      dom.restore();
    }
  });
});

async function mountAndUnmountViewport3DCanvasOnce(): Promise<void> {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const htmlElement = globalThis.HTMLElement as unknown as {
    prototype: { getBoundingClientRect: () => DOMRect };
  };
  const originalRect = htmlElement.prototype.getBoundingClientRect;
  htmlElement.prototype.getBoundingClientRect = () =>
    ({ height: 240, width: 320 }) as DOMRect;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    disconnect() {}
    observe() {
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve() {}
  } as typeof ResizeObserver;
  const root = createReactRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(
        <Viewport3DCanvas dpr={1} frameloop="demand">
          <group />
        </Viewport3DCanvas>,
      );
    });
    await act(async () => {
      fiber.resolvers.splice(0).forEach((resolve) => resolve());
    });
    await act(async () => root.unmount());
  } finally {
    htmlElement.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = originalObserver;
    dom.restore();
  }
}

describe("Viewport3DCanvas WebGL context disposal (M-07)", () => {
  afterEach(() => {
    fiber.setGlStub(null);
    fiber.configurations.length = 0;
    fiber.renders.length = 0;
    fiber.roots.length = 0;
    fiber.resolvers.length = 0;
  });

  it("releases the WebGL context on unmount: renderLists -> dispose -> forceContextLoss", async () => {
    const order: string[] = [];
    const gl = createLifecycleTestGlStub(order);
    fiber.setGlStub(gl);

    await mountAndUnmountViewport3DCanvasOnce();

    expect(gl.renderLists.dispose).toHaveBeenCalledTimes(1);
    expect(gl.dispose).toHaveBeenCalledTimes(1);
    expect(gl.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["renderLists", "dispose", "forceContextLoss"]);
  });

  it("never lets a failed context dispose block unmount", async () => {
    const gl = createLifecycleTestGlStub();
    gl.dispose.mockImplementation(() => {
      throw new Error("boom");
    });
    fiber.setGlStub(gl);

    await expect(mountAndUnmountViewport3DCanvasOnce()).resolves.not.toThrow();
    // forceContextLoss must NOT run after a dispose() throw — three would be
    // asked to lose a context it never released cleanly.
    expect(gl.forceContextLoss).not.toHaveBeenCalled();
  });

  it("tolerates a missing renderer without throwing", async () => {
    fiber.setGlStub(null);

    await expect(mountAndUnmountViewport3DCanvasOnce()).resolves.not.toThrow();
  });
});
