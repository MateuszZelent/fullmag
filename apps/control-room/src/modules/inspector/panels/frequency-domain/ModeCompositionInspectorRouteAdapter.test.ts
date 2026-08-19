import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const adapterSource = readFileSync(
  fileURLToPath(new URL("./ModeCompositionInspectorRouteAdapter.tsx", import.meta.url)),
  "utf8",
);
const registrySource = readFileSync(
  fileURLToPath(new URL("../../inspectorRegistry.tsx", import.meta.url)),
  "utf8",
);

describe("ModeCompositionInspectorRouteAdapter", () => {
  it("makes every registry route provide the shared non-null dependency envelope", () => {
    expect(adapterSource).toContain("useModeCompositionControllerResource()");
    expect(adapterSource).toContain("useFrequencyDomainEigenSpectrumV3Resource()");
    expect(adapterSource).toContain("useSceneResource()");
    expect(adapterSource).toContain("modeCompositionInspectorDependenciesFromResources");

    for (const route of [
      "EigenSpectrumCompositionInspectorRoute",
      "ModeCompositionActiveInspectorRoute",
      "ModeCompositionObjectsInspectorRoute",
      "ModeCompositionObjectInspectorRoute",
    ]) {
      expect(adapterSource).toContain(`function ${route}`);
    }

    expect(registrySource).toContain(
      '"results.eigen.spectrum": EigenSpectrumCompositionInspectorRoute',
    );
    expect(registrySource).toContain(
      '"results.eigen.composition": ModeCompositionActiveInspectorRoute',
    );
    expect(registrySource).toContain(
      '"results.eigen.composition.objects": ModeCompositionObjectsInspectorRoute',
    );
    expect(registrySource).toContain(
      '"results.eigen.composition.object": ModeCompositionObjectInspectorRoute',
    );
    expect(adapterSource.match(/dependencies=\{dependencies\}/g)).toHaveLength(4);
  });
});
