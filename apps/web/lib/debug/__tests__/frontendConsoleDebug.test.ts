import { beforeEach, describe, expect, it, vi } from "vitest";

describe("frontendConsoleDebug", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not write diagnostic console output unless the explicit console flag is enabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const debugModule = await import("../frontendConsoleDebug");

    debugModule.writeFrontendDiagnosticConsole("info", "hidden");

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("writes diagnostic console output when the explicit console flag is enabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const flagsModule = await import("../frontendDiagnosticFlags");
    flagsModule.FRONTEND_DIAGNOSTIC_FLAGS.diagnosticConsole.enableFrontendRuntimeLogs = true;
    const debugModule = await import("../frontendConsoleDebug");

    debugModule.writeFrontendDiagnosticConsole("info", "visible", { count: 1 });

    expect(infoSpy).toHaveBeenCalledWith("visible", { count: 1 });
  });
});
