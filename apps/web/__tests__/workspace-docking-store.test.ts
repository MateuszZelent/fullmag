import { beforeEach, describe, expect, it } from "vitest";

import {
  getDefaultActiveWorkspaceTabByStage,
  getDefaultDockingStorageKey,
  getDefaultWorkspaceTabsByStage,
  useWorkspaceStore,
} from "../lib/workspace/workspace-store";

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
    dockLayoutByStage: {
      build: null,
      study: null,
      analyze: null,
    },
    currentStage: "analyze",
  });
}

describe("workspace docking store", () => {
  beforeEach(() => {
    (globalThis as { window?: { localStorage: MemoryStorage } }).window = {
      localStorage: memoryStorage,
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
    const model = {
      global: { splitterSize: 6 },
      layout: { type: "row", children: [] },
      borders: [],
    } as Record<string, unknown>;

    useWorkspaceStore.getState().setDockLayout("study", model);

    expect(useWorkspaceStore.getState().dockLayoutByStage.study).toEqual(model);

    const stored = memoryStorage.getItem(getDefaultDockingStorageKey());
    expect(stored).toBeTruthy();
    expect(stored).toContain("splitterSize");
  });
});
