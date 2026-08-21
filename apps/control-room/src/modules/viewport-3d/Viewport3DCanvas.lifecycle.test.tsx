import { act, StrictMode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

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
  return { configurations, renders, resolvers, roots };
});

vi.mock("@react-three/fiber", () => ({
  createRoot: vi.fn(() => {
    const events = { connect: vi.fn(), disconnect: vi.fn() };
    const root = {
      configure: vi.fn((configuration) => {
        fiber.configurations.push(configuration);
        configuration.onCreated?.({
          events,
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
