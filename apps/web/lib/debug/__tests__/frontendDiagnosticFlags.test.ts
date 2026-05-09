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

  it("normalizes VectorSurface ViewCube visibility even when stale persisted flags disable it", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        vectorSurfaceViewport: {
          showViewCube: false,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.vectorSurfaceViewport.showViewCube).toBe(true);
  });

  it("contains workspace graph bridge flag in defaults", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.workspace.enableWorkspaceGraphBridge).toBe(true);
  });

  it("contains leak isolation kill switches in defaults", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.leakIsolation.enableHiddenViewportBridge).toBe(true);
    expect(defaults.leakIsolation.enableSessionDataPlaneBridge).toBe(true);
    expect(defaults.leakIsolation.enableScalarHydration).toBe(true);
    expect(defaults.leakIsolation.enableMeshTopologyHydration).toBe(true);
    expect(defaults.leakIsolation.enableDomainTopologyHydration).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshTopologyHydration).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshSummaryHydration).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshManifestHydration).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshTopologyFetch).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshTopologyDecode).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshStoreMerge).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshStoreRead).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshMergeWithExistingStoreMesh).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshStoreFemMeshWrite).toBe(true);
    expect(defaults.leakIsolation.enableSharedDomainMeshStoreApply).toBe(true);
    expect(defaults.leakIsolation.enableControlRoomFemMeshConsumption).toBe(true);
    expect(defaults.leakIsolation.enableControlRoomFemMeshDomainLayoutInput).toBe(true);
    expect(defaults.leakIsolation.enableControlRoomFemMeshFieldDataInput).toBe(true);
    expect(defaults.leakIsolation.enableControlRoomFemMeshDerivedModelInput).toBe(true);
    expect(defaults.leakIsolation.enableControlRoomFemMeshContextPublish).toBe(true);
    expect(defaults.leakIsolation.enableViewportFemMeshView3DRender).toBe(true);
    expect(defaults.leakIsolation.enableViewportHostedFemMeshTabRender).toBe(true);
    expect(defaults.leakIsolation.enableViewportHostedFem3DRender).toBe(true);
    expect(defaults.leakIsolation.enableViewportMinimalFem3DRender).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DSceneRender).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DGeometryRender).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DArrowRender).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DOverlayRender).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DAutoFit).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DAutoFitGenerationEffect).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DBlankViewportRecovery).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DAutoFitComponent).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DAutoFitCameraApply).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DAutoFitInvalidate).toBe(true);
    expect(defaults.leakIsolation.enableFemMeshView3DAutoFitRecord).toBe(true);
    expect(defaults.leakIsolation.enableLegacyBinaryFemTopologyHydration).toBe(true);
    expect(defaults.leakIsolation.enableBinaryFieldHydration).toBe(false);
    expect(defaults.leakIsolation.enableIdleLiveStatusPolling).toBe(false);
  });

  it("preserves persisted leak isolation kill switches", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        leakIsolation: {
          enableHiddenViewportBridge: false,
          enableScalarHydration: false,
        },
      }),
    );

    const loaded = loadFrontendDiagnosticFlagsFromStorage();
    expect(loaded.leakIsolation.enableHiddenViewportBridge).toBe(false);
    expect(loaded.leakIsolation.enableScalarHydration).toBe(false);
    expect(loaded.leakIsolation.enableBinaryFieldHydration).toBe(false);
  });

  it("keeps the VectorSurface 3D canvas enabled in the normal defaults", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.vectorSurfaceViewport.enableCanvas3D).toBe(true);
  });

  it("keeps the WebGL visual activity readPixels probe disabled by default", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.viewportCore.enableCanvasVisualActivityProbe).toBe(false);
  });

  it("keeps the VectorSurface ViewCube enabled in the normal defaults", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    expect(defaults.vectorSurfaceViewport.showViewCube).toBe(true);
  });

  it("keeps the HSL orientation reference enabled by default", () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    const debugViewportProfile = getProfileById("debug-viewport");

    expect(defaults.femViewport.showOrientationSphere).toBe(true);
    expect(debugViewportProfile?.overrides.femViewport?.showOrientationSphere).toBe(true);
    expect(debugViewportProfile?.overrides.interactions?.trace).toBe(true);
  });

  it("provides a leak-isolation diagnostic profile", () => {
    const profile = getProfileById("leak-isolation");
    expect(profile?.overrides.session?.enableLiveWebSocket).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableHiddenViewportBridge).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableScalarHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableMeshTopologyHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableDomainTopologyHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshTopologyHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshSummaryHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshManifestHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshTopologyFetch).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshTopologyDecode).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshStoreMerge).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshStoreRead).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshMergeWithExistingStoreMesh).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshStoreFemMeshWrite).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableSharedDomainMeshStoreApply).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableControlRoomFemMeshConsumption).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableControlRoomFemMeshDomainLayoutInput).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableControlRoomFemMeshFieldDataInput).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableControlRoomFemMeshDerivedModelInput).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableControlRoomFemMeshContextPublish).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableViewportFemMeshView3DRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableViewportHostedFemMeshTabRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableViewportHostedFem3DRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableViewportMinimalFem3DRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DSceneRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DGeometryRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DArrowRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DOverlayRender).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DAutoFit).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DAutoFitGenerationEffect).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DBlankViewportRecovery).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DAutoFitComponent).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DAutoFitCameraApply).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DAutoFitInvalidate).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableFemMeshView3DAutoFitRecord).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableLegacyBinaryFemTopologyHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableBinaryFieldHydration).toBe(false);
    expect(profile?.overrides.leakIsolation?.enableIdleLiveStatusPolling).toBe(false);
  });

  it("preserves persisted HSL orientation sphere kill switch", () => {
    memoryStorage.setItem(
      "fullmag.frontend_diagnostic_flags.v1",
      JSON.stringify({
        femViewport: {
          showOrientationSphere: false,
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

  it("preserves persisted HSL orientation sphere when enabled", () => {
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
