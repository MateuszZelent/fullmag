import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  magneticTextureInspectorView,
  syncAuthoringScriptBestEffort,
} from "./ObjectMagneticTexturePanelViewModel";

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
    expect(magneticTextureInspectorView("object.region.texture")).toBe("region");
    expect(magneticTextureInspectorView("object.region-magnetic-texture")).toBe(
      "region",
    );
  });

  it("uses semantic dirty checks instead of JSON stringification", () => {
    const objectPanel = readFileSync(
      new URL("./ObjectMagneticTexturePanel.tsx", import.meta.url),
      "utf8",
    );
    const regionPanel = readFileSync(
      new URL("./region/ObjectRegionTexturePanel.tsx", import.meta.url),
      "utf8",
    );

    expect(objectPanel).toContain("objectMagneticTextureDraftDirty");
    expect(regionPanel).toContain("objectMagneticTextureDraftDirty");
    expect(objectPanel).not.toContain("JSON.stringify(draft)");
    expect(regionPanel).not.toContain("JSON.stringify(draft)");
  });

  it("saves the asset and assignment through one atomic transaction", () => {
    const source = readFileSync(
      new URL("./ObjectMagneticTexturePanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("buildMagnetizationTransactionRequest(");
    expect(source).toContain("api.model.commitTransaction(");
    expect(source).toContain("initial_magnetization.uniform");
    expect(source).toContain("initial_magnetization.vortex");
    expect(source).not.toContain("patchMagnetizationAsset(");
    expect(source).not.toContain("patchRegion(");
    expect(source).not.toContain("patchObject(model.objectId");
  });
});
