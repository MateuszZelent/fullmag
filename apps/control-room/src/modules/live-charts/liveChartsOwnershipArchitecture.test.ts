import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");
const governingDocuments = [
  "docs/adr/0016-center-viewport-tabbed-surfaces.md",
  "docs/adr/0022-live-charts-analysis-boundary.md",
  "docs/specs/frontend-v2/01-module-kernel-architecture.md",
  "docs/specs/frontend-v2/02-module-catalog.md",
  "docs/specs/frontend-v2/16-charts-analysis-module.md",
  "docs/analysis-tab-refactoring-plan.md",
] as const;

function repoSource(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("Live Charts, Analysis, and Quick Chart ownership", () => {
  it.each(governingDocuments)("documents all three independent surfaces in %s", (path) => {
    const source = repoSource(path);

    expect(source).toContain("Live Charts");
    expect(source).toContain("Analysis");
    expect(source).toContain("Quick Chart");
    expect(source).toContain("explicit selected dataset");
  });

  it("does not preserve the mixed Analysis live-follow workbench", () => {
    const source = governingDocuments.map(repoSource).join("\n");

    expect(source).not.toMatch(/Analysis[^\n]*(?:Follow\/Pause|live table|implicitly follows)/i);
    expect(source).not.toMatch(/Quick Chart[^\n]*MountedModule\(analysis-plots/i);
  });

  it("keeps old preference and descriptor identities read-only", () => {
    const livePreferences = repoSource("apps/control-room/src/kernel/workspace/liveChartPreferences.ts");
    const quickChartPreferences = repoSource("apps/control-room/src/kernel/workspace/quickChartWorkspace.ts");
    const explorerSelection = repoSource("apps/control-room/src/modules/explorer/explorerSelection.ts");

    expect(livePreferences).not.toMatch(/writeStorage\([^\n]*ANALYSIS_CHART_PREFERENCES_STORAGE_KEY/);
    expect(quickChartPreferences).not.toMatch(/\byAxisIds\s*:/);
    expect(explorerSelection).not.toMatch(/\byAxisIds\s*:/);
  });

  it.each([
    "apps/control-room/src/kernel/workspace/liveChartPreferences.ts",
    "apps/control-room/src/kernel/workspace/analysisViewPreferences.ts",
    "apps/control-room/src/kernel/workspace/quickChartWorkspace.ts",
    "apps/control-room/src/modules/explorer/explorerTypes.ts",
  ])("gives every remaining compatibility reader an owner and removal gate in %s", (path) => {
    const source = repoSource(path);

    expect(source).toContain("Compatibility owner:");
    expect(source).toContain("Removal gate:");
  });
});
