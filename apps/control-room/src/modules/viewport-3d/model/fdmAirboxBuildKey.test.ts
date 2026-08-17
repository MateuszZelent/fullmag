import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildViewport3DFdmCuboidJobKey } from "../build-engine/viewport3dBuildJobKeys";

const sceneModelSource = fileURLToPath(
  new URL("../hooks/useViewport3DSceneModel.ts", import.meta.url),
);

describe("FDM Airbox build identity", () => {
  it("keeps geometry identity independent and scopes field identity to vector-only builds", () => {
    const source = readFileSync(sceneModelSource, "utf8");
    const keyStart = source.indexOf("const fdmAirboxBuildKey =");
    const keyBlock = source.slice(
      keyStart,
      source.indexOf("const fdmAirboxBuildState =", keyStart),
    );

    expect(keyBlock).toMatch(
      /fieldRevision:\s*fdmAirboxVectorOnlyBuildEnabled\s*\?/,
    );
    expect(keyBlock).toMatch(
      /quantityId:\s*fdmAirboxVectorOnlyBuildEnabled\s*\?/,
    );
    expect(keyBlock).not.toContain(
      'field=${fdmAirboxFieldVector ? "ready" : "pending"}',
    );

    const common = {
      algorithmVersion: 1,
      domainId: "shared-domain",
      domainGenerationId: "generation-1",
      samplingRevision: "sampling-1",
      scopeId: "airbox",
      scopeKind: "airbox" as const,
      sessionId: "current",
      styleRevision: "fill=0.8|airbox=true",
      topologyRevision: "topology-1",
    };
    const geometryKeyForState = (
      _fieldRevision: string | null,
      _quantityId: string | null,
    ) =>
      buildViewport3DFdmCuboidJobKey({
        ...common,
        // The geometry branch deliberately discards field identity.
        fieldRevision: null,
        quantityId: null,
      });
    expect(geometryKeyForState("field-1", "m")).toBe(
      geometryKeyForState("field-2", "H_demag"),
    );
    expect(
      buildViewport3DFdmCuboidJobKey({
        ...common,
        fieldRevision: "field-1",
        quantityId: "m",
      }),
    ).not.toBe(
      buildViewport3DFdmCuboidJobKey({
        ...common,
        fieldRevision: "field-2",
        quantityId: "H_demag",
      }),
    );
  });
});
