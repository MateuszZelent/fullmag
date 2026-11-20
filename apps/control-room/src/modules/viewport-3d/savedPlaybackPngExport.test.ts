import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.unstubAllGlobals();
  });

  it("applies the saved viewport PNG settings", async () => {
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: () => link, body: { append } });
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

    await downloadSavedPlaybackPng(canvas, "saved-study.png");

    expect(captureViewport3DImageMock).toHaveBeenCalledWith(canvas, {
      annotations: false,
      background: "transparent",
      scale: 4,
    });
    expect(append).toHaveBeenCalledWith(link);
    expect(link.href).toBe("blob:saved-playback");
    expect(link.download).toBe("saved-study.png");
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(link.href);
  });
});
