import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const kernelProviderSource = readFileSync(
  join(process.cwd(), "src/kernel/KernelProvider.tsx"),
  "utf8",
);

describe("KernelProvider performance contracts", () => {
  it("keeps the global shortcut listener stable across runtime resource updates", () => {
    expect(kernelProviderSource).toContain(
      "runtimeResourceDataRef.current = runtimeResourceData",
    );
    expect(kernelProviderSource).toContain(
      "resourceData: runtimeResourceDataRef.current",
    );
    expect(kernelProviderSource).toContain(
      "}, [kernel, startupVisible]);",
    );
    expect(kernelProviderSource).not.toContain(
      "}, [kernel, runtimeResourceData, startupVisible]);",
    );
    expect(kernelProviderSource).not.toContain(
      "}, [kernel, runtimeResourceData, startupState.isVisible]);",
    );
  });

  it("uses startup visibility selectors only for interactions that must wait for the workspace", () => {
    expect(kernelProviderSource).toContain(
      "useSimulationStartupOverlayVisibility",
    );
    expect(kernelProviderSource).toContain(
      "const startupVisible = useSimulationStartupOverlayVisibility();",
    );
    expect(kernelProviderSource).not.toContain(
      "function RealtimeConnector({ kernel }: { kernel: KernelApi }) {\n  const startupVisible",
    );
    expect(kernelProviderSource).not.toContain("if (startupVisible) {\n      return;\n    }\n\n    if (typeof WebSocket");
    expect(kernelProviderSource).not.toContain("useSessionStatus");
    expect(kernelProviderSource).not.toContain(
      "resolveSimulationStartupOverlayState",
    );
    expect(kernelProviderSource).not.toContain("startupState.isVisible");
  });

  it("exports fullmag performance measures into diagnostics", () => {
    expect(kernelProviderSource).toContain("PerformanceDiagnosticsConnector");
    expect(kernelProviderSource).toContain("startPerformanceMeasureDiagnostics");
    expect(kernelProviderSource).toContain("startBrowserActivityDiagnostics");
    expect(kernelProviderSource).toContain(
      "diagnostics: kernel.diagnostics",
    );
  });

  it("creates and drains the diagnostic recorder early in the kernel", () => {
    expect(kernelProviderSource).toContain("DiagnosticRecorderController");
    expect(kernelProviderSource).toContain("createBinaryDecodeScheduler");
    expect(kernelProviderSource).toContain("installDiagnosticConsoleCapture");
    expect(kernelProviderSource).toContain("recordDiagnosticBrowserSnapshot");
    expect(kernelProviderSource).toContain("recordBinaryDecodeDiagnostic");
    expect(kernelProviderSource).toContain(
      "__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__",
    );
    expect(kernelProviderSource).toContain("diagnosticRecorder.mark");
    expect(kernelProviderSource).toContain("DiagnosticRecorderConnector");
    expect(kernelProviderSource).toContain(
      "kernel.diagnosticRecorder.drainEarlyRecorder()",
    );
    expect(kernelProviderSource).toContain("DIAGNOSTIC_EVENT_NAMES.kernelCreated");
  });

  it("can skip performance diagnostics from browser runtime flags", () => {
    expect(kernelProviderSource).toContain(
      "performanceDiagnosticsEnabledFromBrowserConfig",
    );
    expect(kernelProviderSource).toContain(
      "if (!performanceDiagnosticsEnabledFromBrowserConfig())",
    );
  });

  it("resolves registered modules from runtime browser flags before kernel registration", () => {
    expect(kernelProviderSource).toContain("resolveControlRoomModules");
    expect(kernelProviderSource).toContain(
      "for (const manifest of resolveControlRoomModules())",
    );
    expect(kernelProviderSource).not.toContain(
      "for (const manifest of ALL_MODULES)",
    );
  });

  it("registers frequency-domain analysis overlay commands in the kernel", () => {
    expect(kernelProviderSource).toContain("ANALYSIS_FIELD_OVERLAY_COMMANDS");
    expect(kernelProviderSource).toContain(
      "const analysisFieldOverlay = new AnalysisFieldOverlayController();",
    );
    expect(kernelProviderSource).toContain(
      "for (const cmd of ANALYSIS_FIELD_OVERLAY_COMMANDS)",
    );
  });

  it("constructs one visualization debug controller in the immutable kernel", () => {
    expect(kernelProviderSource).toContain(
      'import { VisualizationDebugController } from "./visualization/VisualizationDebugController";',
    );
    expect(kernelProviderSource).toContain(
      "const visualizationDebug = new VisualizationDebugController();",
    );
    expect(kernelProviderSource.match(/new VisualizationDebugController\(\)/g)).toHaveLength(
      1,
    );
    expect(kernelProviderSource).toContain("visualizationDebug,\n    visualizationSync,");
  });

  it("allows controlled browser audits to disable realtime websocket coupling", () => {
    expect(kernelProviderSource).toContain("disableRealtime");
    expect(kernelProviderSource).toContain(
      "controlRoomRealtimeDisabledFromBrowser()",
    );
    expect(kernelProviderSource).toContain(
      "if (controlRoomRealtimeDisabledFromBrowser())",
    );
  });

  it("exposes a controlled browser audit hook for hysteresis replay selection", () => {
    expect(kernelProviderSource).toContain("loadHysteresisReplaySnapshot");
    expect(kernelProviderSource).toContain("enableAuditHooks");
    expect(kernelProviderSource).toContain('targetKind: "hysteresis-step"');
    expect(kernelProviderSource).toContain("kernel.layout.setActiveViewportMainModule(\"viewport-3d\")");
    expect(kernelProviderSource).toContain("kernel.layout.setFocusedSlot(\"viewport-main\")");
  });

  it("keeps the browser audit hook out of ordinary production builds", () => {
    expect(kernelProviderSource).toContain("NEXT_PUBLIC_AUDIT_BUILD");
    expect(kernelProviderSource).toContain("process.env.NODE_ENV === \"production\" && !auditBuild");
    expect(kernelProviderSource).toContain("setActiveViewportMainModule");
  });

  it("pauses viewport-3d-only resource hooks when a non-3D center tab is active", () => {
    expect(kernelProviderSource).toContain(
      "createViewport3DInactiveResourcePauseController",
    );
    expect(kernelProviderSource).toContain(
      "<Viewport3DResourceLifecycleConnector kernel={kernel} />",
    );
  });
});
