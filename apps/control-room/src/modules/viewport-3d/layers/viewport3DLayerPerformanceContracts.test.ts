import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { resolveViewport3DFdmNativeLayerFieldRequests } from "../model/viewport3DFieldDataPlan";

const fallbackTopologyMeshLayerSource = readFileSync(
  new URL("./FallbackTopologyMeshLayer.tsx", import.meta.url),
  "utf8",
);
const meshPartLayerSource = readFileSync(
  new URL("./MeshPartLayer.tsx", import.meta.url),
  "utf8",
);
const fdmCuboidLayerSource = readFileSync(
  new URL("./FdmCuboidLayer.tsx", import.meta.url),
  "utf8",
);
const viewport3dBuildEngineTypesSource = readFileSync(
  new URL("../build-engine/viewport3dBuildEngineTypes.ts", import.meta.url),
  "utf8",
);
const viewport3dBuildSchedulerSource = readFileSync(
  new URL("../build-engine/viewport3dBuildScheduler.ts", import.meta.url),
  "utf8",
);
const viewport3dRenderModelSource = readFileSync(
  new URL("../viewport3dRenderModel.ts", import.meta.url),
  "utf8",
);
const viewport3dTopologyIndexModelSource = readFileSync(
  new URL("../viewport3dTopologyIndexModel.ts", import.meta.url),
  "utf8",
);
const viewport3dSceneModelSource = readFileSync(
  new URL("../hooks/useViewport3DSceneModel.ts", import.meta.url),
  "utf8",
);

describe("viewport 3D layer performance contracts", () => {
  it("moves fallback topology edge and point index derivation out of R3F render layers", () => {
    expect(viewport3dTopologyIndexModelSource).toContain(
      "fallbackSurfaceEdgeIndices",
    );
    expect(viewport3dTopologyIndexModelSource).toContain(
      "fallbackSurfaceNodeIndices",
    );
    expect(viewport3dRenderModelSource).toContain(
      "fallbackSurfaceEdgeIndices",
    );
    expect(viewport3dRenderModelSource).toContain(
      "fallbackSurfaceNodeIndices",
    );
    expect(fallbackTopologyMeshLayerSource).not.toContain(
      "buildSurfaceEdgeGeometry",
    );
    expect(fallbackTopologyMeshLayerSource).not.toContain(
      "buildViewport3DPointGeometry",
    );
    expect(fallbackTopologyMeshLayerSource).not.toContain(
      "uniqueSortedSurfaceIndices(",
    );
  });

  it("renders mesh-part points from prepared topology node indices without compacting positions in React", () => {
    expect(viewport3dTopologyIndexModelSource).toContain("surfaceNodeIndices");
    expect(viewport3dRenderModelSource).toContain("surfaceNodeIndices");
    expect(meshPartLayerSource).not.toContain("buildViewport3DPointGeometry");
  });

  it("routes FDM cuboid model and vector segment derivation through an async build lane", () => {
    const fdmLayerComponentSource = fdmCuboidLayerSource.slice(
      fdmCuboidLayerSource.indexOf("export const FdmCuboidLayer"),
    );

    expect(viewport3dBuildEngineTypesSource).toContain('"fdm-cuboid"');
    expect(viewport3dBuildSchedulerSource).toContain('"fdm-cuboid": 1');
    expect(fdmCuboidLayerSource).toContain("useFdmCuboidBuildResult");
    expect(fdmCuboidLayerSource).toContain(
      "buildViewport3DFdmCuboidOffMainThread",
    );
    expect(fdmLayerComponentSource).not.toContain(
      "buildFdmCuboidInstanceModel(",
    );
    expect(fdmLayerComponentSource).not.toContain("buildFdmVectorSegments(");
    expect(viewport3dSceneModelSource).not.toContain(
      "const fdmInstanceModel = useMemo",
    );
    expect(viewport3dSceneModelSource).not.toContain(
      "buildFdmCuboidInstanceModel(",
    );
    expect(viewport3dSceneModelSource).toContain(
      "useFdmCuboidBuildResults",
    );
    expect(viewport3dSceneModelSource).not.toContain(
      "buildFdmDenseNativeLayerInstanceModel(",
    );
  });

  it("cleans native multilayer request ownership 2 -> 1 -> 0 and changes quantity target-locally", () => {
    const settings = (activeQuantityId: string, visible: boolean) => ({
      activeQuantityId,
      shaderVisible: true,
      vectorsVisible: false,
      visible,
    });
    const plan = (bottomVisible: boolean, topVisible: boolean, topQuantity = "m") =>
      resolveViewport3DFdmNativeLayerFieldRequests({
        available: true,
        layers: [
          { layerId: "layer:bottom", settings: settings("m", bottomVisible) },
          { layerId: "layer:top", settings: settings(topQuantity, topVisible) },
        ],
        maxSamples: 256,
      });

    const both = plan(true, true);
    expect([...both.keys()]).toEqual(["layer:bottom", "layer:top"]);
    expect(both.get("layer:bottom")?.consumers).toEqual([
      "viewport-3d:fdm-native-layer:layer:bottom",
    ]);
    expect(both.get("layer:top")?.consumers).toEqual([
      "viewport-3d:fdm-native-layer:layer:top",
    ]);

    const one = plan(false, true);
    expect([...one.keys()]).toEqual(["layer:top"]);
    const none = plan(false, false);
    expect(none.size).toBe(0);

    const topChanged = plan(true, true, "H_demag");
    expect(topChanged.get("layer:bottom")).toEqual(both.get("layer:bottom"));
    expect(topChanged.get("layer:top")?.quantityId).toBe("H_demag");
    expect(topChanged.get("layer:top")?.requestId).toBe(
      "fdm-native-layer:layer:top:H_demag",
    );
  });

  it("keys multilayer cuboid builds from target-local carrier, field, and settings identities", () => {
    const buildBlock = viewport3dSceneModelSource.slice(
      viewport3dSceneModelSource.indexOf("const fdmMultilayerCuboidBuildEntries"),
      viewport3dSceneModelSource.indexOf("const fdmMultilayerCuboidBuildResults"),
    );

    expect(buildBlock).toContain("payloadRevisionByRequestId.get");
    expect(buildBlock).toContain("domain.gridFingerprint");
    expect(buildBlock).toContain("fdmMultilayerAirboxDomain.carrierFingerprint");
    expect(buildBlock).not.toContain("renderingState?.revision");
    expect(buildBlock).not.toContain("nativeLayerFieldVectors.payloadRevision ??");
    expect(buildBlock).not.toContain("nativeLayerFieldVectors.revision ??");
  });
});
