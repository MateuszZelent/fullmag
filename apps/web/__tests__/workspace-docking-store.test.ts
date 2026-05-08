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
    const firstId = useWorkspaceStore.getState().openTab("study", {
      key: "manual:fft",
      kind: "result-vortex-frequency",
      title: "Vortex FFT",
    });
    const secondId = useWorkspaceStore.getState().openTab("study", {
      key: "manual:fft",
      kind: "result-vortex-frequency",
      title: "Vortex FFT",
    });

    expect(secondId).toBe(firstId);
    const tabs = useWorkspaceStore
      .getState()
      .workspaceTabsByStage.study.filter((tab) => tab.key === "manual:fft");
    expect(tabs).toHaveLength(1);
    expect(useWorkspaceStore.getState().activeWorkspaceTabByStage.study).toBe(firstId);
  });

  it("syncTabsFromArtifacts creates auto eigen tabs", () => {
    useWorkspaceStore.getState().syncTabsFromArtifacts("study", [
      "eigen/spectrum.json",
      "eigen/dispersion.json",
      "eigen/modes/mode_0007.json",
    ]);

    const tabs = useWorkspaceStore.getState().workspaceTabsByStage.study;
    expect(tabs.some((tab) => tab.key === "auto:eigen:spectrum")).toBe(true);
    expect(tabs.some((tab) => tab.key === "auto:eigen:dispersion")).toBe(true);
    expect(tabs.some((tab) => tab.key === "auto:eigen:modes")).toBe(true);
  });

  it("closeTab does not close pinned/non-closable tabs", () => {
    useWorkspaceStore.getState().closeTab("study", "core:3d");
    const tabsAfterProtectedClose = useWorkspaceStore.getState().workspaceTabsByStage.study;
    expect(tabsAfterProtectedClose.some((tab) => tab.id === "core:3d")).toBe(true);

    const userTabId = useWorkspaceStore.getState().openTab("study", {
      key: "manual:dispersion",
      kind: "result-dispersion",
      title: "Dispersion",
      closable: true,
      pinned: false,
    });

    useWorkspaceStore.getState().closeTab("study", userTabId);
    const tabsAfterUserClose = useWorkspaceStore.getState().workspaceTabsByStage.study;
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

  it("does not expose analyze as a workspace stage", () => {
    expect(Object.keys(getDefaultWorkspaceTabsByStage())).toEqual(["build", "study"]);
    expect(Object.keys(getDefaultActiveWorkspaceTabByStage())).toEqual(["build", "study"]);
    expect(Object.keys(getDefaultDockingLayoutByPreset())).toEqual(["build", "study"]);
  });

  it("keeps core viewport tabs persistent", () => {
    const defaults = getDefaultWorkspaceTabsByStage();
    const studyTabs = defaults.study;
    expect(studyTabs.find((tab) => tab.id === "core:3d")?.mountPolicy).toBe("hidden-mounted");
    expect(studyTabs.find((tab) => tab.id === "core:2d")?.mountPolicy).toBe("hidden-mounted");
    expect(studyTabs.some((tab) => tab.id === "core:mesh")).toBe(false);
    expect(studyTabs.find((tab) => tab.id === "core:charts")?.mountPolicy).toBe("active-only");
  });

  it("normalizes persisted legacy core charts warm lifecycle back to active-only", () => {
    const tabs = getDefaultWorkspaceTabsByStage();
    for (const stage of ["build", "study"] as const) {
      tabs[stage] = tabs[stage].map((tab) =>
        tab.id === "core:charts" ? { ...tab, keepAlive: true, lifecycle: "warm" } : tab,
      ) as typeof tabs[typeof stage];
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
    expect(chartsTab?.mountPolicy).toBe("active-only");
    expect(chartsTab).not.toHaveProperty("lifecycle");
    expect(chartsTab).not.toHaveProperty("keepAlive");
  });

  it("normalizes legacy mount lifecycle inputs to mount policy", () => {
    const hiddenMountedId = useWorkspaceStore.getState().openTab("study", {
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
    expect(tabs.find((tab) => tab.id === hiddenMountedId)?.mountPolicy).toBe("hidden-mounted");
    expect(tabs.find((tab) => tab.id === coldId)?.mountPolicy).toBe("active-only");
    expect(tabs.find((tab) => tab.id === "core:3d")?.mountPolicy).toBe("hidden-mounted");
    expect(tabs.find((tab) => tab.id === "core:2d")?.mountPolicy).toBe("hidden-mounted");
  });

  it("normalizes legacy WebGL warm lifecycle inputs to active-only", () => {
    const warmWebGLId = useWorkspaceStore.getState().openTab("study", {
      key: "manual:legacy-warm-3d",
      kind: "viewport-3d",
      title: "Legacy Warm 3D",
      keepAlive: true,
      lifecycle: "warm",
    });

    const tab = useWorkspaceStore
      .getState()
      .workspaceTabsByStage.study.find((candidate) => candidate.id === warmWebGLId);
    expect(tab?.mountPolicy).toBe("active-only");
    expect(tab).not.toHaveProperty("lifecycle");
    expect(tab).not.toHaveProperty("keepAlive");
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
