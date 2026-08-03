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
const migrationStrategyPath = "docs/specs/frontend-v2/07-migration-strategy.md";

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

  it("marks migration as Phase 6 reference-only work without declaring cutover", () => {
    const source = repoSource(migrationStrategyPath);

    expect(source).toContain("**Current phase:** Phase 6 — modules/parity.");
    expect(source).toContain("`apps/legacy_web` remains reference-only.");
    expect(source).toContain("This marker does not declare cutover, freeze, or removal.");
  });

  it("documents one renderer owner per chart, including both comparison panes", () => {
    const source = repoSource("docs/specs/frontend-v2/16-charts-analysis-module.md");

    expect(source).toMatch(
      /Each mounted\s+chart or comparison pane owns at most one ECharts instance/,
    );
    expect(source).toMatch(/Comparison surface intentionally owns two pane instances/);
    expect(source).not.toContain("Each mounted surface owns at most one instance");
  });

  it("dates the module catalog implementation snapshot to the current update", () => {
    const source = repoSource("docs/specs/frontend-v2/02-module-catalog.md");

    expect(source).toContain("As of 2026-08-03");
    expect(source).not.toContain("As of 2026-05-22");
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
