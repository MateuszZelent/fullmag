import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { analysisPlotsManifest } from "./manifest";

describe("Analysis manifest Quick Chart boundary", () => {
  it("keeps Analysis in viewport-main and contributes a neutral Quick Chart command", () => {
    expect(analysisPlotsManifest.slots).toEqual(["viewport-main"]);
    const commandIds = analysisPlotsManifest.contributes?.commands?.map((command) => command.id) ?? [];
    expect(commandIds).toContain("quick-chart.pin");
    expect(commandIds).not.toContain("analysis-plots.quick-chart.open");
  });

  it("does not make Analysis a panel-bottom or footer owner", () => {
    const source = readFileSync(new URL("./manifest.ts", import.meta.url), "utf8");
    expect(source).not.toContain('slots: ["viewport-main", "panel-bottom"]');
    expect(source).not.toContain("FooterModule");
    expect(source).not.toContain("TabsTrigger");
  });
});
