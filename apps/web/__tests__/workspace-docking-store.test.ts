import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getDefaultActiveWorkspaceTabByStage,
  getDefaultDockingStorageKey,
  getDefaultDockingLayoutByPreset,
  getDefaultWorkspaceTabsByStage,
  useWorkspaceStore,
} from "../lib/workspace/workspace-store";
import { createDefaultDockLayout } from "../components/workspace/docking/dockLayoutDefaults";

class MemoryStorage {
  private data = new Map<string, string>();
  clear() {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const memoryStorage = new MemoryStorage();

function resetDockingStore() {
  useWorkspaceStore.setState({
    workspaceTabsByStage: getDefaultWorkspaceTabsByStage(),
    activeWorkspaceTabByStage: getDefaultActiveWorkspaceTabByStage(),
    dockLayoutByStage: getDefaultDockingLayoutByPreset(),
    currentStage: "study",
  });
}

describe("workspace docking store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as {
      window?: {
        localStorage: MemoryStorage;
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
      };
    }).window = {
      localStorage: memoryStorage,
      setTimeout,
      clearTimeout,
    };
    memoryStorage.clear();
    resetDockingStore();
  });

  it("openTab deduplicates by key and activates existing tab", () => {
    const firstId = useWorkspaceStore.getState().openTab("analyze", {
      key: "manual:fft",
      kind: "result-vortex-frequency",
      title: "Vortex FFT",
    });
    const secondId = useWorkspaceStore.getState().openTab("analyze", {
      key: "manual:fft",
      kind: "result-vortex-frequency",
      title: "Vortex FFT",
    });

    expect(secondId).toBe(firstId);
    const tabs = useWorkspaceStore
      .getState()
      .workspaceTabsByStage.analyze.filter((tab) => tab.key === "manual:fft");
    expect(tabs).toHaveLength(1);
    expect(useWorkspaceStore.getState().activeWorkspaceTabByStage.analyze).toBe(firstId);
  });

  it("syncTabsFromArtifacts creates auto eigen tabs", () => {
    useWorkspaceStore.getState().syncTabsFromArtifacts("analyze", [
      "eigen/spectrum.json",
      "eigen/dispersion.json",
      "eigen/modes/mode_0007.json",
    ]);

    const tabs = useWorkspaceStore.getState().workspaceTabsByStage.analyze;
    expect(tabs.some((tab) => tab.key === "auto:eigen:spectrum")).toBe(true);
    expect(tabs.some((tab) => tab.key === "auto:eigen:dispersion")).toBe(true);
    expect(tabs.some((tab) => tab.key === "auto:eigen:modes")).toBe(true);
  });

  it("closeTab does not close pinned/non-closable tabs", () => {
    useWorkspaceStore.getState().closeTab("analyze", "core:3d");
    const tabsAfterProtectedClose = useWorkspaceStore.getState().workspaceTabsByStage.analyze;
    expect(tabsAfterProtectedClose.some((tab) => tab.id === "core:3d")).toBe(true);

    const userTabId = useWorkspaceStore.getState().openTab("analyze", {
      key: "manual:dispersion",
      kind: "result-dispersion",
      title: "Dispersion",
      closable: true,
      pinned: false,
    });

    useWorkspaceStore.getState().closeTab("analyze", userTabId);
    const tabsAfterUserClose = useWorkspaceStore.getState().workspaceTabsByStage.analyze;
    expect(tabsAfterUserClose.some((tab) => tab.id === userTabId)).toBe(false);
  });

  it("setDockLayout persists model to localStorage", () => {
    const model = createDefaultDockLayout("desktop") as Record<string, unknown>;
    const nextModel = structuredClone(model) as Record<string, unknown>;
    const globalNode = nextModel.global as Record<string, unknown> | undefined;
    if (globalNode) {
      globalNode.splitterSize = 7;
    }

    useWorkspaceStore.getState().setDockLayout("study", "desktop", nextModel);

    expect(useWorkspaceStore.getState().dockLayoutByStage.study.desktop?.model).toMatchObject(nextModel);
    expect(
      useWorkspaceStore.getState().dockLayoutByStage.study.desktop?.dockingLayoutSchemaVersion,
    ).toBe(1);
    expect(useWorkspaceStore.getState().dockLayoutByStage.study.desktop?.wasRecovered).toBe(false);

    vi.runAllTimers();

    const stored = memoryStorage.getItem(getDefaultDockingStorageKey());
    expect(stored).toBeTruthy();
    expect(stored).toContain("dockingLayoutSchemaVersion");
    expect(stored).toContain("splitterSize");
  });

  it("imports invalid snapshot stage using study as the safe default", () => {
    const imported = useWorkspaceStore.getState().importUiStateSnapshot({
      version: 1,
      docking: {
        workspaceTabsByStage: getDefaultWorkspaceTabsByStage(),
        activeWorkspaceTabByStage: getDefaultActiveWorkspaceTabByStage(),
        dockLayoutByStage: {
          build: { desktop: null, tablet: null, mobile: null },
          study: { desktop: null, tablet: null, mobile: null },
          analyze: { desktop: null, tablet: null, mobile: null },
        },
      },
      currentStage: "results",
      rightInspectorOpen: false,
      rightInspectorTab: "properties",
    });

    expect(imported).toBe(true);
    expect(useWorkspaceStore.getState().currentStage).toBe("study");
  });

  it("normalizes legacy analyze stage writes to study", () => {
    useWorkspaceStore.getState().setCurrentStage("build");
    expect(useWorkspaceStore.getState().currentStage).toBe("build");

    useWorkspaceStore.getState().setCurrentStage("analyze");

    expect(useWorkspaceStore.getState().currentStage).toBe("study");
  });

  it("keeps core 3D and 2D tabs warm while leaving charts cold", () => {
    const defaults = getDefaultWorkspaceTabsByStage();
    const studyTabs = defaults.study;
    expect(studyTabs.find((tab) => tab.id === "core:3d")?.lifecycle).toBe("warm");
    expect(studyTabs.find((tab) => tab.id === "core:3d")?.keepAlive).toBe(true);
    expect(studyTabs.find((tab) => tab.id === "core:2d")?.lifecycle).toBe("warm");
    expect(studyTabs.find((tab) => tab.id === "core:2d")?.keepAlive).toBe(true);
    expect(studyTabs.some((tab) => tab.id === "core:mesh")).toBe(false);
    expect(studyTabs.find((tab) => tab.id === "core:charts")?.lifecycle).toBe("unmount-on-hide");
    expect(studyTabs.find((tab) => tab.id === "core:charts")?.keepAlive).toBe(false);
  });

  it("normalizes persisted core charts tabs back to cold lifecycle", () => {
    const tabs = getDefaultWorkspaceTabsByStage();
    for (const stage of ["build", "study", "analyze"] as const) {
      tabs[stage] = tabs[stage].map((tab) =>
        tab.id === "core:charts" ? { ...tab, keepAlive: true, lifecycle: "warm" } : tab,
      );
    }

    const imported = useWorkspaceStore.getState().importUiStateSnapshot({
      version: 1,
      docking: {
        workspaceTabsByStage: tabs,
        activeWorkspaceTabByStage: getDefaultActiveWorkspaceTabByStage(),
        dockLayoutByStage: getDefaultDockingLayoutByPreset(),
      },
      currentStage: "study",
      rightInspectorOpen: true,
      rightInspectorTab: "properties",
    });

    expect(imported).toBe(true);
    const chartsTab = useWorkspaceStore
      .getState()
      .workspaceTabsByStage.study.find((tab) => tab.id === "core:charts");
    expect(chartsTab?.lifecycle).toBe("unmount-on-hide");
    expect(chartsTab?.keepAlive).toBe(false);
  });

  it("normalizes non-core warm lifecycle inputs back to cold tabs", () => {
    const warmId = useWorkspaceStore.getState().openTab("study", {
      key: "manual:charts-clone",
      kind: "viewport-charts",
      title: "Charts Clone",
      lifecycle: "warm",
    });
    const coldId = useWorkspaceStore.getState().openTab("study", {
      key: "manual:3d-clone",
      kind: "viewport-3d",
      title: "3D Clone",
    });

    const tabs = useWorkspaceStore.getState().workspaceTabsByStage.study;
    expect(tabs.find((tab) => tab.id === warmId)?.keepAlive).toBe(false);
    expect(tabs.find((tab) => tab.id === warmId)?.lifecycle).toBe("unmount-on-hide");
    expect(tabs.find((tab) => tab.id === coldId)?.keepAlive).toBe(false);
    expect(tabs.find((tab) => tab.id === coldId)?.lifecycle).toBe("unmount-on-hide");
    expect(tabs.find((tab) => tab.id === "core:3d")?.lifecycle).toBe("warm");
    expect(tabs.find((tab) => tab.id === "core:2d")?.lifecycle).toBe("warm");
  });

  it("keeps simple UI setters idempotent for unchanged values", () => {
    const before = useWorkspaceStore.getState();
    before.setSelectionId(before.selectionId);
    before.setActiveProjectId(before.activeProjectId);
    before.setLauncherVisible(before.launcherVisible);
    before.setLaunchIntent(before.launchIntent);
    before.setRightInspectorOpen(before.rightInspectorOpen);
    before.setRightInspectorTab(before.rightInspectorTab);
    before.setSettingsOpen(before.settingsOpen);
    const afterUnchanged = useWorkspaceStore.getState();
    expect(afterUnchanged).toBe(before);

    afterUnchanged.setSelectionId("node:test");
    const afterChanged = useWorkspaceStore.getState();
    expect(afterChanged.selectionId).toBe("node:test");
  });
});
