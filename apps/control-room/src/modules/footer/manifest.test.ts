import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { ALL_MODULES } from "@/modules/registry";

import { footerManifest } from "./manifest";

describe("footerManifest", () => {
  it("mounts the transport footer in the bottom panel slot", () => {
    expect(footerManifest).toMatchObject({
      id: "transport-footer",
      slots: ["panel-bottom"],
      title: "Transport Footer",
    });
    expect(ALL_MODULES.map((manifest) => manifest.id)).toContain(
      "transport-footer",
    );
  });

  it("keeps operational footer tabs and mounts their heavy content only while active", () => {
    const source = readFileSync(
      new URL("./FooterModule.tsx", import.meta.url),
      "utf8",
    );

    for (const tab of ["logs", "telemetry", "diagnostics", "engine", "mesh"]) {
      expect(source).toContain(`TabsTrigger value="${tab}"`);
      expect(source).toContain(`activeTab === "${tab}"`);
    }
    expect(source).not.toContain('TabsTrigger value="analysis"');
    expect(source).not.toContain("Quick Chart");
  });
});
