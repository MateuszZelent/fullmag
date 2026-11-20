import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import type { Viewport3DExportMode } from "../viewport3dInspectorState";
import { viewport3dStore } from "../viewport3dStore";
import { Viewport3DExportPanel } from "./Viewport3DExportPanel";
import type { ViewportModelSource } from "./viewportModelExportAction";

const export3DModelMock = vi.fn();

vi.mock("@/shared/export-3d", () => ({
  export3DModel: (...args: unknown[]) => export3DModelMock(...args),
}));

function makeModelSource(overrides?: Partial<ViewportModelSource>): ViewportModelSource {
  return {
    defaultColorMode: "hsl_3d",
    defaultPalette: "coolwarm",
    provenance: { discretization: "fdm" },
    quantityId: "m",
    sourceLabel: "Accepted live frame",
    suggestedFilenameStem: "film-m-step-42",
    targets: [
      {
        appearance: { includeSurface: true, includeVectors: true },
        field: {
          componentCount: 3,
          domain: "cell",
          kind: "real",
          name: "m",
          values: new Float32Array([1, 0, 0]),
        },
        geometry: {
          cellTypes: new Uint8Array([11]),
          connectivity: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
          kind: "unstructured",
          offsets: new Uint32Array([8]),
          positions: new Float32Array(24),
        },
        id: "obj_film",
        label: "Film",
        role: "magnetic",
      },
      {
        appearance: { includeSurface: false, includeWireframe: true },
        geometry: {
          cellTypes: new Uint8Array([11]),
          connectivity: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
          kind: "unstructured",
          offsets: new Uint32Array([8]),
          positions: new Float32Array(24),
        },
        id: "airbox",
        label: "Airbox",
        role: "airbox",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function elementById(container: TestElement, id: string): TestElement {
  return findElement(container, (element) => element.getAttribute("id") === id, id);
}

describe("Viewport3DExportPanel", () => {
  beforeEach(() => {
    viewport3dStore.resetForTest();
    export3DModelMock.mockReset();
  });

  afterEach(() => {
    viewport3dStore.resetForTest();
    vi.restoreAllMocks();
  });

  it("renders segmented PNG and 3D model options", () => {
    const html = renderToStaticMarkup(
      <Viewport3DExportPanel
        activeMode="png"
        getSource={async () => makeModelSource()}
        onCommand={() => undefined}
        onModeChange={() => undefined}
      />,
    );
    const tabs = Array.from(
      html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g),
      (match) => match[1],
    );
    expect(tabs).toEqual(["PNG", "3D model"]);
    expect(html).toContain('aria-label="3D Export"');
  });

  it("exports PNG through the capture command and exposes PNG options", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const onCommand = vi.fn();

    try {
      await act(async () => {
        root.render(
          <Viewport3DExportPanel
            activeMode="png"
            getSource={async () => makeModelSource()}
            onCommand={onCommand}
            onModeChange={() => undefined}
          />,
        );
      });

      expect(elementById(container, "fm-view-export-background")).toBeDefined();
      expect(elementById(container, "fm-view-export-scale")).toBeDefined();
      expect(elementById(container, "fm-view-export-annotations")).toBeDefined();
      const exportButton = findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent === "Export PNG",
        "Export PNG",
      );
      await act(async () => {
        exportButton.click();
      });
      expect(onCommand).toHaveBeenCalledWith("viewport-3d.capture-frame");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("loads the current 3D view in 3D mode and exports with fresh source data", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const getSource = vi
      .fn<() => Promise<ViewportModelSource>>()
      .mockResolvedValueOnce(makeModelSource({ suggestedFilenameStem: "film-initial" }))
      .mockResolvedValueOnce(makeModelSource({ suggestedFilenameStem: "film-fresh" }));

    export3DModelMock.mockResolvedValue({
      bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
      filename: "film-fresh.glb",
      format: "glb",
      mimeType: "model/gltf-binary",
    });

    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test-3d-export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    let mode: Viewport3DExportMode = "3d";
    const renderPanel = async () => {
      await act(async () => {
        root.render(
          <Viewport3DExportPanel
            activeMode={mode}
            getSource={getSource}
            onCommand={() => undefined}
            onModeChange={(next) => {
              mode = next;
            }}
          />,
        );
      });
    };

    try {
      await renderPanel();
      expect(getSource).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Accepted live frame · m");

      const filenameInput = elementById(container, "fm-view-export-3d-filename");
      expect(filenameInput.value).toBe("film-initial");

      const airboxToggle = elementById(container, "fm-view-export-3d-airbox");
      expect(airboxToggle.getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        airboxToggle.click();
      });
      expect(airboxToggle.getAttribute("aria-checked")).toBe("true");

      // Customize file name before exporting.
      filenameInput.focus();
      filenameInput.value = "custom-scene";
      await act(async () => {
        filenameInput.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });

      const export3DButton = findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent === "Export 3D",
        "Export 3D",
      );
      await act(async () => {
        export3DButton.click();
      });

      expect(getSource).toHaveBeenCalledTimes(2);
      expect(export3DModelMock).toHaveBeenCalledTimes(1);
      const exportCall = export3DModelMock.mock.calls[0]?.[0] as {
        options: { filename: string; format: string };
        targets: Array<{ role: string }>;
      };
      expect(exportCall.options).toMatchObject({
        filename: "custom-scene",
        format: "glb",
      });
      expect(exportCall.targets.map((target) => target.role)).toEqual([
        "magnetic",
        "airbox",
      ]);
      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
