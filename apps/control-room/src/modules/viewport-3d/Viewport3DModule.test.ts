import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  notifyMeshTopologyRendered,
  resolveViewport3DColorbarLegend,
  resolveViewport3DMeshQualityLegend,
} from "./Viewport3DModule";

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

describe("resolveViewport3DColorbarLegend", () => {
  it("describes numeric component coloring with quantity, component, unit, and range", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "x",
        quantityId: "m",
        range: { max: 0.75, min: -0.25 },
        unit: "1",
      }),
    ).toEqual({
      label: "m x [1]",
      maxLabel: "0.75",
      minLabel: "-0.25",
    });
  });

  it("describes material scalar coloring without a vector component suffix", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "magnitude",
        quantityId: "mat_ms",
        range: { max: 800e3, min: 400e3 },
        unit: "A/m",
      }),
    ).toEqual({
      label: "mat_ms [A/m]",
      maxLabel: "800000",
      minLabel: "400000",
    });
  });

  it("stays hidden for orientation and HSL sphere coloring", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "orientation",
        quantityId: "m",
        range: { max: 1, min: 0 },
        unit: "1",
      }),
    ).toBeNull();
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "hsl_sphere",
        quantityId: "m",
        range: { max: 1, min: 0 },
        unit: "1",
      }),
    ).toBeNull();
  });
});

describe("notifyMeshTopologyRendered", () => {
  it("emits one topology-rendered event per mesh revision", () => {
    const emit = vi.fn();
    const lastRevision = { current: null as string | number | null };

    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision,
      meshRevision: 7,
      rendererId: "viewport-3d-main",
    });
    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision,
      meshRevision: 7,
      rendererId: "viewport-3d-main",
    });
    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision,
      meshRevision: "8",
      rendererId: "viewport-3d-main",
    });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, "mesh:topology-rendered", {
      meshRevision: 7,
      rendererId: "viewport-3d-main",
    });
    expect(emit).toHaveBeenNthCalledWith(2, "mesh:topology-rendered", {
      meshRevision: "8",
      rendererId: "viewport-3d-main",
    });
  });

  it("does not emit before a real topology revision is known", () => {
    const emit = vi.fn();

    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision: { current: null },
      meshRevision: null,
      rendererId: "viewport-3d-main",
    });

    expect(emit).not.toHaveBeenCalled();
  });
});

describe("Viewport3DModule scene wiring", () => {
  it("keeps ordinary camera gestures local while explicit camera patches persist", () => {
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
    expect(saveCameraStateSource).not.toContain("kernel.cameraRegistry.patchCamera");
    expect(saveCameraStateSource).toContain("orthographicScale");
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

  it("does not remount the native canvas when postprocessing antialiasing changes", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("key={`viewport-3d-canvas-${visualProfile.id}`}");
    expect(source).not.toContain("${effectAntialias ? \"aa\" : \"no-aa\"}");
  });

  it("keeps canvas DPR fixed during camera gestures to avoid zoom flicker", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );
    const canvasStart = source.indexOf("<Canvas");
    const canvasBlock = source.slice(canvasStart, source.indexOf(">", canvasStart));

    expect(canvasBlock).toContain("dpr={canvasDpr}");
    expect(source).not.toContain('import { AdaptiveDpr } from "@react-three/drei";');
    expect(source).not.toContain("<AdaptiveDpr");
    expect(source).not.toContain("interactionActive: sceneProps.interactionActive");
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
    expect(source).toContain(
      'data-camera-up={sceneProps.cameraState.up.join(" ")}',
    );
  });

  it("mounts an explicit field-data issue dialog for missing shader or vector data", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Viewport3DResourceIssueDialog");
    expect(source).toContain("fieldDataIssue");
    expect(source).toContain("Magnetic field data unavailable");
  });

  it("gates the temporary azimuth and polar controls behind an explicit browser debug flag", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("viewport3DOrbitDebugEnabledFromBrowserConfig()");
    expect(source).toContain("const orbitDebugEnabled =");
    expect(source).toContain("orbitDebugEnabled && clientReady && colors");
    expect(source).toContain(
      "onOrbitDebugAnglesChange={\n              orbitDebugEnabled ? syncOrbitDebugAngles : undefined\n            }",
    );
    expect(source).toContain("Viewport3DOrbitDebugPanel");
    expect(source).toContain('aria-label="Temporary orbit controls"');
    expect(source).toContain('label="Azimuth"');
    expect(source).toContain('label="Polar"');
    expect(source).toContain("orbitDebugRevision");
    expect(source).toContain("orbitDebugCommitRevision");
    expect(source).toContain("onAnglesCommit={commitOrbitDebugAngles}");
  });

  it("offers authored, realized, and combined region overlay modes", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('useState<RegionOverlayMode>("both")');
    expect(source).toContain('aria-label="Region overlays"');
    expect(source).toContain("Authored");
    expect(source).toContain("Realized");
    expect(source).toContain("Both");

    const styles = readFileSync(
      new URL("../../design/styles/viewport-3d.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.fm-viewport-3d__region-modes\s*\{[\s\S]*?pointer-events:\s*auto;/,
    );
  });
});
