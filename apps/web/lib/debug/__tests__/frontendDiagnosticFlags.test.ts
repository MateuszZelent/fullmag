import { beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultFrontendDiagnosticFlags,
  loadFrontendDiagnosticFlagsFromStorage,
} from "../frontendDiagnosticFlags";
import { getProfileById } from "@/features/diagnostics/flags/diagnosticProfiles";

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
}

const memoryStorage = new MemoryStorage();

describe("frontendDiagnosticFlags loader", () => {
  beforeEach(() => {
    memoryStorage.clear();
    (globalThis as { window?: { localStorage: MemoryStorage } }).window = {
      localStorage: memoryStorage,
    };
  });

  it("does not force-enable Graph V2 when persisted flag sets it to false", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        workspace: {
          enableGraphV2: false,
          enableWorkspaceGraphBridge: false,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.workspace.enableGraphV2).toBe(false);
    expect(loaded.workspace.enableWorkspaceGraphBridge).toBe(false);
  });

  it("normalizes non-negotiable shell constraints", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        workspace: {
          standaloneDiagnosticViewportMode: "fem",
          enableWorkspaceTree: false,
          enableWorkspaceEntryPage: false,
          enableWorkspaceShell: false,
          enableRunControlRoom: false,
        },
        shell: {
          showRibbonBar: false,
          showViewportBar: false,
        },
        viewportRouting: {
          enableUnifiedViewportToolbar: false,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.workspace.standaloneDiagnosticViewportMode).toBe("off");
    expect(loaded.workspace.enableWorkspaceTree).toBe(true);
    expect(loaded.workspace.enableWorkspaceEntryPage).toBe(true);
    expect(loaded.workspace.enableWorkspaceShell).toBe(true);
    expect(loaded.workspace.enableRunControlRoom).toBe(true);
    expect(loaded.shell.showRibbonBar).toBe(true);
    expect(loaded.shell.showViewportBar).toBe(false);
    expect(loaded.viewportRouting.enableUnifiedViewportToolbar).toBe(true);
  });

  it("normalizes critical FEM render passes even when persisted diagnostic flags disable them", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        femViewport: {
          showSurfacePass: false,
          showPointsPass: false,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.femViewport.showSurfacePass).toBe(true);
    expect(loaded.femViewport.showPointsPass).toBe(true);
  });

  it("contains workspace graph bridge flag in defaults", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.workspace.enableWorkspaceGraphBridge).toBe(true);
  });

  it("keeps the VectorSurface 3D canvas enabled in the normal defaults", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.vectorSurfaceViewport.enableCanvas3D).toBe(true);
  });

  it("keeps the extra HSL orientation sphere opt-in outside debug viewport profile", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    const debugViewportProfile = getProfileById("debug-viewport");

    expect(defaults.femViewport.showOrientationSphere).toBe(false);
    expect(debugViewportProfile?.overrides.femViewport?.showOrientationSphere).toBe(true);
    expect(debugViewportProfile?.overrides.interactions?.trace).toBe(true);
  });

  it("normalizes persisted HSL orientation sphere unless trace diagnostics are explicit", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        femViewport: {
          showOrientationSphere: true,
        },
        renderDebug: {
          enableRenderLogging: true,
        },
        interactions: {
          trace: false,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.femViewport.showOrientationSphere).toBe(false);
  });

  it("preserves persisted HSL orientation sphere when trace diagnostics are explicit", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        femViewport: {
          showOrientationSphere: true,
        },
        renderDebug: {
          enableRenderLogging: true,
        },
        interactions: {
          trace: true,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.femViewport.showOrientationSphere).toBe(true);
  });
});
