import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sceneModelSource = fileURLToPath(
  new URL("../hooks/useViewport3DSceneModel.ts", import.meta.url),
);

describe("FDM Airbox build identity", () => {
  it("keeps the topology build key independent of quantity and field readiness", () => {
    const source = readFileSync(sceneModelSource, "utf8");
    const keyStart = source.indexOf("const fdmAirboxBuildKey =");
    const keyBlock = source.slice(
      keyStart,
      source.indexOf("const fdmAirboxVectorOnlyBuildInput", keyStart),
    );

    expect(keyBlock).not.toContain("fieldRevision:");
    expect(keyBlock).not.toContain("quantityId:");
    expect(keyBlock).not.toContain(
      'field=${fdmAirboxFieldVector ? "ready" : "pending"}',
    );
  });
});
