import { describe, expect, it, vi } from "vitest";

import {
  magneticTextureInspectorView,
  syncAuthoringScriptBestEffort,
} from "./ObjectMagneticTexturePanel";

describe("ObjectMagneticTexturePanel", () => {
  it("does not propagate canonical script rewrite failures from texture save", async () => {
    const api = {
      model: {
        syncAuthoringScript: vi.fn(async () => {
          throw new Error(
            "canonical rewrite does not yet support stage-local geometry, material, or output mutations",
          );
        }),
      },
    };

    await expect(syncAuthoringScriptBestEffort(api)).resolves.toContain(
      "stage-local geometry",
    );
    expect(api.model.syncAuthoringScript).toHaveBeenCalledWith({});
  });

  it("maps every magnetic texture tree node to its own inspector view", () => {
    expect(magneticTextureInspectorView("object.magnetic-texture")).toBe(
      "overview",
    );
    expect(magneticTextureInspectorView("object.magnetic-texture.asset")).toBe(
      "asset",
    );
    expect(magneticTextureInspectorView("object.magnetic-texture.load")).toBe(
      "load",
    );
    expect(magneticTextureInspectorView("object.magnetic-texture.transform")).toBe(
      "transform",
    );
    expect(magneticTextureInspectorView("object.region-magnetic-texture")).toBe(
      "region",
    );
  });
});
