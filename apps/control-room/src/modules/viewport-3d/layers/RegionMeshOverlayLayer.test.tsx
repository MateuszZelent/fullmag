import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("RegionMeshOverlayLayer", () => {
  it("renders prebuilt async region overlay models without lifting status through effects", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("models: readonly RegionMeshOverlayModel[]");
    expect(source).not.toContain("useViewport3DRegionOverlayModels");
    expect(source).not.toContain("onBuildStatusChange");
    expect(source).not.toContain("buildViewport3DRegionOverlayModels(");
    expect(source).not.toContain("buildRegionMeshOverlayModels(");
  });

  it("uses depth-tested selection-shell policy for realized region surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "renderOrder={RENDER_POLICIES.selectionShell.renderOrder}",
    );
    expect(source).toContain('materialPolicyProps("selectionShell")');
    expect(source).toContain("colorWrite={model.surfaceOverlayVisible}");
    expect(source).toContain(
      "model.surfaceOverlayVisible && model.style.fillOpacity >= 1",
    );
    expect(source).toContain(
      "!model.surfaceOverlayVisible || model.style.fillOpacity < 1",
    );
    expect(source).not.toContain("depthTest={false}");
    expect(source).not.toContain("computeVertexNormals");
  });

  it("routes realized overlay geometry adoption through the GPU upload manager", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );
    const shapeSource = source.slice(
      source.indexOf("function RegionMeshOverlayShape"),
    );

    expect(source).toContain("createViewport3DGpuUploadManager");
    expect(source).toContain("useRegionMeshOverlayGeometryUpload");
    expect(source).toContain('lane: "region-overlay"');
    expect(shapeSource).not.toContain("const surfaceGeometry = useMemo");
    expect(shapeSource).not.toContain("const edgeGeometry = useMemo");
  });

  it("keeps previous realized overlay geometry visible while replacement uploads", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );
    const uploadEffect = source.slice(
      source.indexOf("useEffect(() => {"),
      source.indexOf("const abortController = new AbortController();"),
    );

    expect(uploadEffect).toContain("if (!enabled || !indices?.length) {");
    expect(uploadEffect).toContain("clearCurrentGeometry();");
    expect(source).toContain("if (store.getSnapshot().geometry !== uploadedGeometry)");
    expect(source).not.toContain("if (store.getSnapshot().geometry === uploadedGeometry)");
    expect(uploadEffect).not.toContain("useEffect(() => {\n    store.publish(null);");
  });
});
