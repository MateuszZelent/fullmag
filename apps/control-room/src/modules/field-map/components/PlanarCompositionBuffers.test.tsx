import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { findElement, installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { buildFieldMapRenderModel } from "../model/fieldMapRenderModel";
import { planarModelRenderKey, type PlanarRenderEvidence } from "../model/fieldMapEvidence";
import type { PlanarCompositionFrame } from "../model/planarCompositionFrame";
import { PlanarCompositionBuffers } from "./PlanarCompositionBuffers";

const renderer = vi.hoisted(() => ({ callbacks: new Map<string, (evidence: PlanarRenderEvidence) => void>() }));
vi.mock("../renderer/PlanarSurface", () => ({ PlanarSurface: (props: {
  model: FieldMapRenderModel; onRenderEvidence: (evidence: PlanarRenderEvidence) => void; fieldOverlayContent?: ReactNode;
}) => {
  renderer.callbacks.set(`base:${props.model.sampleIdentity}`, props.onRenderEvidence);
  return <div><canvas data-test-base={props.model.sampleIdentity} />{props.fieldOverlayContent}</div>;
} }));
vi.mock("../renderer/PlanarOverlaySurface", () => ({ PlanarOverlaySurface: (props: {
  id: string; model: FieldMapRenderModel; onRenderEvidence: (evidence: PlanarRenderEvidence) => void;
}) => {
  renderer.callbacks.set(`overlay:${props.model.sampleIdentity}`, props.onRenderEvidence);
  return <canvas data-test-overlay={props.model.sampleIdentity} />;
} }));
vi.mock("./PlanarColorLegend", () => ({ PlanarColorLegend: () => null }));

function frame(sample: string): PlanarCompositionFrame {
  const model = buildFieldMapRenderModel({ bounds: [0, 1, 0, 1], canonicalUnit: "1", component: "magnitude",
    frame: { normal: [0, 0, 1], origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    layers: { contours: false, mesh: false, raster: true, vectors: false },
    range: { mode: "auto" }, resolution: [1, 1], scalar: new Float64Array([1]), sampleIdentity: sample });
  const meta = { quantity_id: "m" } as PlanarFieldMetaResource;
  return { base: { meta, model }, overlays: [{ id: "magnet", meta, model }], coherence: "verified" };
}
function acknowledge(next: PlanarCompositionFrame, layer: string) {
  renderer.callbacks.get(`${layer}:${next.base.model.sampleIdentity}`)!({
    sampleIdentity: next.base.model.sampleIdentity, renderKey: planarModelRenderKey(next.base.model),
    glyphCount: 0, overlayCounts: { contours: 0, meshSegments: 0 }, raster: null,
  });
}

describe("planar canvas buffer lifecycle", () => {
  it("keeps stable A/B canvases and hides incomplete stacks through repeated updates", async () => {
    const dom = installSimulationPreparationTestDom(); const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element); const onRenderEvidence = vi.fn();
    const render = async (next: PlanarCompositionFrame) => {
      await act(async () => root.render(<PlanarCompositionBuffers frame={next} scopeKey="session"
        payloadPending={false} surfaceProps={{ onRenderEvidence }} />));
    };
    const first = frame("one"); const second = frame("two"); const third = frame("three");
    try {
      await render(first);
      const slotA = findElement(container, (node) => node.getAttribute("data-planar-composition-slot") === "A", "slot A")!;
      const firstCanvas = findElement(slotA, (node) => node.tagName === "CANVAS", "buffer canvas")!;
      expect(slotA.style.visibility).toBe("hidden");
      await act(async () => acknowledge(first, "base")); expect(slotA.style.visibility).toBe("hidden");
      expect(onRenderEvidence).not.toHaveBeenCalled();
      await act(async () => acknowledge(first, "overlay")); expect(slotA.style.visibility).toBe("visible");
      expect(onRenderEvidence).toHaveBeenCalledTimes(1);
      await render(second);
      const slotB = findElement(container, (node) => node.getAttribute("data-planar-composition-slot") === "B", "slot B")!;
      const secondCanvas = findElement(slotB, (node) => node.tagName === "CANVAS", "buffer canvas")!;
      expect(slotA.style.visibility).toBe("visible"); expect(slotB.style.visibility).toBe("hidden");
      await act(async () => { acknowledge(second, "base"); acknowledge(second, "overlay"); });
      expect(slotA.style.visibility).toBe("hidden"); expect(slotB.style.visibility).toBe("visible");
      await render(third);
      expect(findElement(slotA, (node) => node.tagName === "CANVAS", "buffer canvas")).toBe(firstCanvas);
      expect(findElement(slotB, (node) => node.tagName === "CANVAS", "buffer canvas")).toBe(secondCanvas);
      expect(slotA.style.visibility).toBe("hidden"); expect(slotB.style.visibility).toBe("visible");
    } finally { await act(async () => root.unmount()); dom.restore(); renderer.callbacks.clear(); }
  });
});
