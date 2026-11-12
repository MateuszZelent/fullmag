import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { fieldMapSurfaceStore } from "@/kernel/visualization/fieldMapSurfaceStore";
import { planarToolStore } from "@/kernel/visualization/planarToolStore";

import { fieldMapCommands } from "../fieldMapCommands";
import { fieldMapToolCommands } from "../fieldMapToolCommands";
import { fieldMapViewCommands } from "../fieldMapViewCommands";
import { PlanarToolbar } from "./PlanarToolbar";

const mocks = vi.hoisted(() => ({
  kernel: null as unknown as Record<string, unknown>,
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
  useKernel: () => mocks.kernel,
}));

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;

function installKernel(active = true) {
  const commands = new CommandRegistry();
  for (const command of [...fieldMapCommands, ...fieldMapViewCommands, ...fieldMapToolCommands]) {
    commands.register(command);
  }
  const queuePatch = vi.fn();
  mocks.kernel = {
    commands,
    layout: { get: () => ({ activeViewportMainModuleId: active ? "field-map" : "viewport-3d" }) },
    visualizationSync: { flushNow: vi.fn(), queuePatch },
  };
  return { queuePatch };
}

function planar(vectors: boolean): PlanarState {
  return {
    component: "magnitude",
    interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
    layers: {
      boundaries: false, bounds: false, contours: false, mesh: false, points: false,
      probes: true, raster: true, streamlines: false, vectors,
    },
    source: { kind: "default" },
    viewport_colorbar_visible: true,
  } as PlanarState;
}

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe("PlanarToolbar", () => {
  afterEach(() => {
    planarToolStore.reset();
    fieldMapSurfaceStore.reset();
  });

  it("renders four labelled groups with a six-tool radiogroup", () => {
    installKernel();
    const html = renderToStaticMarkup(<PlanarToolbar />);

    expect(html).toContain('aria-label="2D view tools"');
    expect(html).toMatch(/role="toolbar"/);
    expect(count(html, /role="radiogroup"/g)).toBe(1);
    expect(count(html, /role="group"/g)).toBe(3);
    expect(count(html, /role="radio"/g)).toBe(6);
    expect(html).toMatch(/aria-keyshortcuts="H"[^>]*aria-label="Navigate"|aria-label="Navigate"[^>]*aria-keyshortcuts="H"/);
    expect(html).not.toContain("Quantity");
    expect(html).not.toContain("Free section");
  });

  it("runs the crop tool command and marks it checked", async () => {
    installKernel();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarToolbar />));
      const crop = findElement(container, (element) => element.getAttribute("aria-label") === "Crop", "crop tool");
      expect(crop.getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        crop.dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(planarToolStore.getSnapshot().activeTool).toBe("crop");
      expect(crop.getAttribute("aria-checked")).toBe("true");
      const navigate = findElement(container, (element) => element.getAttribute("aria-label") === "Navigate", "navigate tool");
      expect(navigate.getAttribute("aria-checked")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reflects planar.layers.vectors in the vectors toggle", async () => {
    const { queuePatch } = installKernel();
    fieldMapSurfaceStore.set({ planar: planar(false) });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarToolbar />));
      const vectors = findElement(container, (element) => element.getAttribute("aria-label") === "Vectors", "vectors toggle");
      expect(vectors.getAttribute("aria-pressed")).toBe("false");
      await act(async () => {
        vectors.dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(queuePatch).toHaveBeenCalledWith({ planar: { layers: expect.objectContaining({ vectors: true }) } });
      await act(async () => fieldMapSurfaceStore.set({ planar: planar(true) }));
      expect(vectors.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("disables commands with a reason outside the 2D view", () => {
    installKernel(false);
    const html = renderToStaticMarkup(<PlanarToolbar />);
    expect(html).toContain("Open the 2D view first.");
    expect(html).toContain("disabled");
  });
});
