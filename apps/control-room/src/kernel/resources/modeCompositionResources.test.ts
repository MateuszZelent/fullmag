import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ModeCompositionResource } from "../visualization/ModeCompositionController";
import {
  MODE_COMPOSITION_ACTIVE_RESOURCE_KEY,
  resolveModeCompositionRevision,
} from "./modeCompositionResourceModel";

describe("mode composition resource", () => {
  it("uses one stable resource identity and the composition's own revision", () => {
    expect(MODE_COMPOSITION_ACTIVE_RESOURCE_KEY).toBe(
      "visualization:mode-composition:active",
    );
    expect(resolveModeCompositionRevision({ revision: 17 } as ModeCompositionResource)).toBe(
      17,
    );
  });

  it("loads through the revision-aware resource layer with stale-request abort", () => {
    const source = readFileSync(
      new URL("./modeCompositionResources.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useResource({");
    expect(source).toContain("abortStaleInflight: true");
    expect(source).toContain("client.getActiveModeComposition({ signal })");
    expect(source).not.toContain("fetch(");
  });

  it("binds ready HTTP snapshots into the kernel controller without a module store", () => {
    const source = readFileSync(
      new URL("./modeCompositionResources.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useModeCompositionControllerResource");
    expect(source).toContain("const { api, modeComposition } = useKernel();");
    expect(source).toContain('if (resource.status === "ready" && resource.data)');
    expect(source).toContain("modeComposition.acceptResource(resource.data)");
    expect(source).not.toContain("create(");
  });
});
