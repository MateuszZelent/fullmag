import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { analysisPlotsManifest } from "./manifest";

describe("Analysis Quick Chart dock ownership", () => {
  it("leaves panel-bottom ownership to the transport footer", () => {
    expect(analysisPlotsManifest.slots).toEqual(["viewport-main"]);
    expect(analysisPlotsManifest.slots).not.toContain("panel-bottom");
    expect(analysisPlotsManifest.slots).not.toContain("viewport-aux");

    const source = readFileSync(new URL("./AnalysisPlotsModule.tsx", import.meta.url), "utf8");
    expect(source).toContain('props.slotId === "panel-bottom"');
    expect(source).toContain("<AnalysisQuickChartDock");
    expect(source).not.toContain("display: none");
  });

  it("opens the canonical Analysis bottom tab without changing viewport-main", () => {
    const openBottomPanel = vi.fn();
    const setActiveViewportMainModule = vi.fn();
    const command = analysisPlotsManifest.contributes?.commands?.find(
      (candidate) => candidate.id === "analysis-plots.quick-chart.open",
    );
    expect(command).toBeDefined();
    expect(command?.run({
      layout: { openBottomPanel, setActiveViewportMainModule },
    } as never)).toEqual({ status: "completed" });
    expect(openBottomPanel).toHaveBeenCalledWith("analysis");
    expect(setActiveViewportMainModule).not.toHaveBeenCalled();
  });

  it("uses the footer as the sole bottom-tab host and mounts the shared module variant", () => {
    const source = readFileSync(
      new URL("../footer/FooterModule.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('TabsTrigger value="analysis"');
    expect(source).toContain('slotId="panel-bottom"');
    expect(source).toContain("MountedModule");
  });
});
