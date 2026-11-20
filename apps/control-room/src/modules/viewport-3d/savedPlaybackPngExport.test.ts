import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const { captureViewport3DImageMock } = vi.hoisted(() => ({
  captureViewport3DImageMock: vi.fn(),
}));

vi.mock("./viewport3dImageExport", () => ({
  captureViewport3DImage: captureViewport3DImageMock,
}));

import { viewport3dStore } from "./viewport3dStore";
import { downloadSavedPlaybackPng } from "./savedPlaybackPngExport";

describe("downloadSavedPlaybackPng", () => {
  beforeEach(() => {
    viewport3dStore.resetForTest();
    captureViewport3DImageMock.mockReset();
  });

  afterEach(() => {
    viewport3dStore.resetForTest();
    vi.restoreAllMocks();
  });

  it("applies the saved viewport PNG settings", async () => {
    const dom = installSimulationPreparationTestDom();
    const canvas = {} as HTMLCanvasElement;
    const image = {} as Blob;
    captureViewport3DImageMock.mockResolvedValue(image);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:saved-playback");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    viewport3dStore.setAppearance({
      exportAnnotations: false,
      exportBackground: "transparent",
      exportScale: 4,
    });

    try {
      await downloadSavedPlaybackPng(canvas, "saved-study.png");

      expect(captureViewport3DImageMock).toHaveBeenCalledWith(canvas, {
        annotations: false,
        background: "transparent",
        scale: 4,
      });
    } finally {
      dom.restore();
    }
  });
});
