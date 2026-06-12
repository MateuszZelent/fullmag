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
    expect(kernelProviderSource).toContain('targetKind: "hysteresis-step"');
    expect(kernelProviderSource).toContain("kernel.layout.setActiveViewportMainModule(\"viewport-3d\")");
    expect(kernelProviderSource).toContain("kernel.layout.setFocusedSlot(\"viewport-main\")");
  });
});
