import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveViewport3DMeshQualityLegend } from "./Viewport3DModule";

describe("resolveViewport3DMeshQualityLegend", () => {
  it("describes the active mesh quality metric and range", () => {
    expect(
      resolveViewport3DMeshQualityLegend(true, "sicn", {
        max: 0.92,
        min: 0.17,
      }),
    ).toBe("Mesh quality SICN 0.17 to 0.92");
  });

  it("stays hidden when the overlay is inactive or the range is missing", () => {
    expect(resolveViewport3DMeshQualityLegend(false, "gamma", { max: 1, min: 0 }))
      .toBeNull();
    expect(resolveViewport3DMeshQualityLegend(true, "gamma", null)).toBeNull();
  });
});

describe("Viewport3DModule scene wiring", () => {
  it("writes camera gestures to the kernel camera registry instead of visualization sync", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );
    const patchCameraStart = source.indexOf("const patchCameraState = useCallback");
    const saveCameraStart = source.indexOf("const saveCameraState = useCallback");
    const renderStart = source.indexOf("\n  return (", saveCameraStart);

    expect(patchCameraStart).toBeGreaterThanOrEqual(0);
    expect(saveCameraStart).toBeGreaterThan(patchCameraStart);
    expect(renderStart).toBeGreaterThan(saveCameraStart);

    const patchCameraStateSource = source.slice(patchCameraStart, saveCameraStart);
    const saveCameraStateSource = source.slice(saveCameraStart, renderStart);

    expect(patchCameraStateSource).toContain(
      "kernel.cameraRegistry.patchCamera(patch);",
    );
    expect(patchCameraStateSource).not.toContain("visualizationSync.queuePatch");
    expect(saveCameraStateSource).toContain("viewport3dStore.setCamera(nextCamera);");
    expect(saveCameraStateSource).toContain(
      "kernel.cameraRegistry.patchCamera({",
    );
    expect(saveCameraStateSource).toContain("orthographic_scale");
    expect(saveCameraStateSource).not.toContain("visualizationSync.queuePatch");
    expect(saveCameraStateSource).not.toContain("queuePatch({ camera: nextCamera })");
    expect(source).toContain("kernel.cameraRegistry.beginInteraction();");
    expect(source).toContain("kernel.cameraRegistry.endInteraction();");
    expect(source).toContain(
      "onCameraInteractionStart={beginCameraInteraction}",
    );
    expect(source).toContain("onCameraInteractionEnd={endCameraInteraction}");
  });

  it("forwards dimension-frame widget state into the scene", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "dimensionFrameMode={commandState.widgets.dimensionFrameMode}",
    );
    expect(source).toContain(
      "dimensionFrameDensity={commandState.widgets.dimensionFrameDensity}",
    );
    expect(source).toContain(
      "scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}",
    );
    expect(source).toContain("scaleUnitMode={commandState.widgets.scaleUnitMode}");
  });

  it("exposes camera diagnostics for browser smoke checks", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'data-camera-position={sceneProps.cameraState.position.join(" ")}',
    );
    expect(source).toContain('data-camera-projection={sceneProps.cameraProjection}');
    expect(source).toContain(
      'data-camera-target={sceneProps.cameraState.target.join(" ")}',
    );
  });

  it("mounts the temporary azimuth and polar controls beside the existing R3F canvas", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Viewport3DOrbitDebugPanel");
    expect(source).toContain('aria-label="Temporary orbit controls"');
    expect(source).toContain('label="Azimuth"');
    expect(source).toContain('label="Polar"');
    expect(source).toContain("orbitDebugRevision");
    expect(source).toContain("orbitDebugCommitRevision");
    expect(source).toContain("onAnglesCommit={commitOrbitDebugAngles}");
  });
});
