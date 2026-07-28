import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAnalysisPlotsWorkspaceForTests } from "@/kernel/workspace/analysisPlotsWorkspace";
import {
  quickChartWorkspaceStore,
  resetQuickChartWorkspaceForTests,
} from "@/kernel/workspace/quickChartWorkspace";

import { analysisPlotsManifest } from "./manifest";

afterEach(() => {
  resetAnalysisPlotsWorkspaceForTests();
  resetQuickChartWorkspaceForTests();
});

describe("pinned Quick Chart ownership", () => {
  it("keeps Analysis in viewport-main and does not render a bottom-dock variant", () => {
    expect(analysisPlotsManifest.slots).toEqual(["viewport-main"]);
    const source = readFileSync(new URL("./AnalysisPlotsModule.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("panel-bottom");
    expect(source).not.toContain("AnalysisQuickChartDock");
  });

  it("pins the current chart for the Inspector while 3D stays active", () => {
    const emit = vi.fn();
    const set = vi.fn();
    const setFocusedSlot = vi.fn();
    const command = analysisPlotsManifest.contributes?.commands?.find(
      (candidate) => candidate.id === "analysis-plots.quick-chart.open",
    );
    const context = {
      bus: { emit },
      layout: {
        get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
        setFocusedSlot,
      },
      selection: { set },
    };

    expect(command?.isEnabled?.(context as never)).toBe(true);
    expect(command?.run(context as never)).toEqual({ status: "completed" });
    expect(quickChartWorkspaceStore.getSnapshot().pinned).toEqual(
      expect.objectContaining({ chartId: "default", tableId: "default" }),
    );
    expect(emit).toHaveBeenCalledWith("explorer:tab-requested", {
      source: "analysis-plots",
      tab: "results",
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "results.quick_chart", ref: expect.objectContaining({ type: "quick-chart" }) }),
      "analysis-plots",
    );
    expect(setFocusedSlot).toHaveBeenCalledWith("panel-right");
  });

  it("does not expose Quick Chart as a footer tab", () => {
    const source = readFileSync(
      new URL("../footer/FooterModule.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('TabsTrigger value="analysis"');
    expect(source).not.toContain("Quick Chart");
  });
});
