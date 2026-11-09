import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { planarModelRenderKey, type PlanarRenderEvidence } from "../model/fieldMapEvidence";
import { buildFieldMapRenderModel, type FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { PlanarSurface } from "./PlanarSurface";
import { PlanarOverlaySurface } from "./PlanarOverlaySurface";

const rendererLifecycle = vi.hoisted(() => ({ mounts: 0, cleanups: 0 }));

vi.mock("./usePlanarSurfaceRenderer", async () => {
  const React = await import("react");

  return {
    usePlanarSurfaceRenderer(
      model: FieldMapRenderModel,
      onRenderEvidence?: (evidence: PlanarRenderEvidence) => void,
    ) {
      const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
      const overlayRef = React.useRef<HTMLCanvasElement | null>(null);
      const modelRef = React.useRef(model);
      modelRef.current = model;
      const drawOverlayRef = React.useRef<() => void>(() => undefined);
      const maskRef = React.useRef<Uint8Array | null>(null);
      const valuesRef = React.useRef<Float32Array | Float64Array | null>(null);
      const replayCompletedEvidence = React.useCallback(() => undefined, []);
      const renderStateRef = React.useRef({ axisPointer: null });

      React.useEffect(() => {
        rendererLifecycle.mounts += 1;
        return () => {
          rendererLifecycle.cleanups += 1;
        };
      }, []);
      React.useEffect(() => {
        onRenderEvidence?.({
          glyphCount: 0,
          overlayCounts: { contours: 0, meshSegments: 0 },
          raster: null,
          sampleIdentity: model.sampleIdentity,
          renderKey: planarModelRenderKey(model),
        });
      }, [model, onRenderEvidence]);

      return {
        replayCompletedEvidence,
        canvasRef,
        drawOverlayRef,
        maskRef,
        modelRef,
        overlayRef,
        plotSize: { height: 100, width: 200 },
        renderStateRef,
        valuesRef,
      };
    },
  };
});

function makeRenderModel(
  values: readonly number[],
  sampleIdentity: string,
): FieldMapRenderModel {
  return buildFieldMapRenderModel({
    bounds: [0, 2, 0, 1],
    canonicalUnit: "A/m",
    component: "magnitude",
    frame: {
      normal: [0, 0, 1],
      origin: [0, 0, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
    },
    layers: { contours: false, mesh: false, raster: true, vectors: true },
    range: { mode: "auto" },
    resolution: [values.length, 1],
    sampleIdentity,
    scalar: new Float64Array(values),
  });
}

function overlayCanvases(root: TestElement, id: string): TestElement[] {
  return findElements(root, (element) => element.getAttribute("data-planar-overlay-id") === id);
}

describe("PlanarOverlaySurface composition", () => {
  it("keeps keyed canvases mounted across sample refresh and delegates renderer cleanup", async () => {
    rendererLifecycle.mounts = 0;
    rendererLifecycle.cleanups = 0;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const baseModel = makeRenderModel([1, 2], '"base-sample"');
    const ferroEvidence = vi.fn();
    const demagEvidence = vi.fn();
    const ferroModel = makeRenderModel([3, 4], '"ferro-sample-1"');
    const demagModel = makeRenderModel([5, 6], '"demag-sample"');
    let mounted = false;

    const render = (nextFerroModel: FieldMapRenderModel, includeDemag: boolean) => (
      <PlanarSurface
        model={baseModel}
        fieldOverlayContent={[
          <PlanarOverlaySurface
            key="ferro"
            id="ferro"
            quantityId="M"
            model={nextFerroModel}
            onRenderEvidence={ferroEvidence}
          />,
          ...(includeDemag ? [
            <PlanarOverlaySurface
              key="demag"
              id="demag"
              quantityId="H_demag"
              model={demagModel}
              onRenderEvidence={demagEvidence}
            />,
          ] : []),
        ]}
      />
    );

    try {
      await act(async () => {
        root.render(render(ferroModel, true));
      });
      mounted = true;

      const stack = findElement(
        container,
        (element) => element.getAttribute("class") === "fm-field-map__canvas-stack",
        "planar canvas stack",
      );
      const slot = findElement(
        stack,
        (element) => element.getAttribute("class") === "fm-field-map__field-overlays",
        "field overlay slot",
      );
      const ferroCanvases = overlayCanvases(slot, "ferro");
      const canvasOrder = findElements(
        stack,
        (element) => element.tagName === "CANVAS",
      ).map((canvas) => canvas.getAttribute("data-planar-overlay-layer") ?? (
        canvas.getAttribute("aria-label") === "Planar scalar field" ? "base-raster" : "base-vectors"
      ));
      expect(canvasOrder).toEqual([
        "base-raster",
        "base-vectors",
        "raster",
        "vectors",
        "raster",
        "vectors",
      ]);
      expect(ferroCanvases).toHaveLength(2);
      expect(ferroCanvases.map((canvas) => canvas.getAttribute("data-planar-overlay-layer")))
        .toEqual(["raster", "vectors"]);
      expect(ferroCanvases.map((canvas) => canvas.getAttribute("data-planar-overlay-quantity")))
        .toEqual(["M", "M"]);
      expect(ferroCanvases.map((canvas) => canvas.getAttribute("data-planar-overlay-sample")))
        .toEqual(['"ferro-sample-1"', '"ferro-sample-1"']);
      expect(ferroCanvases.map((canvas) => canvas.getAttribute("aria-hidden")))
        .toEqual(["true", "true"]);
      expect(slot.style.pointerEvents).toBe("none");
      expect(stack.contains(ferroCanvases[0] ?? null)).toBe(true);
      expect(ferroCanvases[0]?.getAttribute("data-planar-overlay-rendered-sample"))
        .toBe('"ferro-sample-1"');
      expect(ferroCanvases[0]?.getAttribute("data-planar-overlay-rendered-current"))
        .toBe("true");
      expect(ferroEvidence).toHaveBeenCalledWith(expect.objectContaining({
        sampleIdentity: '"ferro-sample-1"',
      }));

      const firstRasterCanvas = ferroCanvases[0];
      const refreshedFerroModel = makeRenderModel([7, 8], '"ferro-sample-2"');
      await act(async () => {
        root.render(render(refreshedFerroModel, true));
      });

      const refreshedRasterCanvas = overlayCanvases(slot, "ferro")[0];
      expect(refreshedRasterCanvas).toBe(firstRasterCanvas);
      expect(refreshedRasterCanvas?.getAttribute("data-planar-overlay-sample"))
        .toBe('"ferro-sample-2"');
      expect(refreshedRasterCanvas?.getAttribute("data-planar-overlay-rendered-sample"))
        .toBe('"ferro-sample-2"');

      expect(rendererLifecycle.mounts).toBe(3);
      await act(async () => {
        root.render(render(refreshedFerroModel, false));
      });
      expect(rendererLifecycle.cleanups).toBe(1);
      expect(overlayCanvases(slot, "demag")).toHaveLength(0);

      await act(async () => {
        root.unmount();
      });
      mounted = false;
      expect(rendererLifecycle.cleanups).toBe(3);
    } finally {
      if (mounted) {
        await act(async () => {
          root.unmount();
        });
      }
      dom.restore();
    }
  });
});
