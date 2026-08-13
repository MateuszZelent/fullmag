import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "@/kernel/workspace/analysisWorkspace";
import { analysisPlotsManifest } from "./manifest";

afterEach(() => resetAnalysisWorkspaceForTests());

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

  it("opens an explicit published table identity from a Results action", () => {
    const command = analysisPlotsManifest.contributes?.commands?.find(
      (candidate) => candidate.id === "analysis-plots.open",
    );
    const setActiveViewportMainModule = vi.fn();
    const setFocusedSlot = vi.fn();

    expect(command?.run({
      input: {
        datasetRef: "table:energy",
        surface: "dynamics",
        tableId: "energy",
      },
      layout: { setActiveViewportMainModule, setFocusedSlot },
    } as never)).toEqual({ status: "completed" });
    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      activeSurface: "dynamics",
      selectedDatasetRef: "energy",
      sourceTableId: "energy",
    });
    expect(setActiveViewportMainModule).toHaveBeenCalledWith("analysis-plots");
    expect(setFocusedSlot).toHaveBeenCalledWith("viewport-main");
  });

  it("fails closed for an action whose resource and table identities disagree", () => {
    const command = analysisPlotsManifest.contributes?.commands?.find(
      (candidate) => candidate.id === "analysis-plots.open",
    );

    expect(command?.run({
      input: {
        datasetRef: "artifact:energy.csv",
        surface: "dynamics",
        tableId: "energy",
      },
    } as never)).toEqual({
      message: "Published table Analysis action is invalid.",
      status: "failed",
    });
    expect(analysisWorkspaceStore.getSnapshot().selectedDatasetRef).toBeNull();
  });
});
