import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticWebGLContextRecord,
  installDiagnosticConsoleCapture,
} from "./diagnosticConsoleCapture";
import { DIAGNOSTIC_EVENT_NAMES } from "./diagnosticRecorderTypes";

describe("installDiagnosticConsoleCapture", () => {
  it("records console errors and warnings while preserving originals", () => {
    const records: unknown[] = [];
    const error = vi.fn();
    const warn = vi.fn();
    const target = {
      console: { error, warn },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const cleanup = installDiagnosticConsoleCapture({
      now: () => 10,
      record: (record) => records.push(record),
      target,
    });

    target.console.error("startup failed", { route: "/workspace" });
    target.console.warn("slow frame");
    cleanup();
    target.console.error("after cleanup");

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: "error",
      message: "startup failed {\"route\":\"/workspace\"}",
      name: "console.error",
      severity: "critical",
      timestampMs: 10,
    });
    expect(records[1]).toMatchObject({
      level: "warn",
      message: "slow frame",
      name: "console.warn",
      severity: "warning",
    });
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(target.console.error).toBe(error);
    expect(target.console.warn).toBe(warn);
  });

  it("records page errors and unhandled rejections through removable listeners", () => {
    const records: unknown[] = [];
    const listeners = new Map<string, EventListener>();
    const target = {
      console: { error: vi.fn(), warn: vi.fn() },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    };

    const cleanup = installDiagnosticConsoleCapture({
      now: () => 20,
      record: (record) => records.push(record),
      target,
    });

    listeners.get("error")?.({
      colno: 7,
      filename: "Viewport.tsx",
      lineno: 42,
      message: "render exploded",
    } as unknown as Event);
    listeners.get("unhandledrejection")?.({
      reason: new Error("request failed"),
    } as unknown as Event);
    cleanup();

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "page-error",
      message: "render exploded",
      name: "window.error",
      source: "Viewport.tsx",
    });
    expect(records[1]).toMatchObject({
      kind: "unhandled-rejection",
      name: "window.unhandledrejection",
    });
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "unhandledrejection",
      expect.any(Function),
    );
  });

  it("builds structured WebGL context lifecycle records for viewport probes", () => {
    expect(
      createDiagnosticWebGLContextRecord({
        contextLost: true,
        detail: { owner: "viewport-3d" },
        drawingBufferHeight: 600,
        drawingBufferWidth: 800,
        geometries: 4,
        timestampMs: 30,
      }),
    ).toMatchObject({
      contextLost: true,
      detail: {
        drawingBufferHeight: 600,
        drawingBufferWidth: 800,
        owner: "viewport-3d",
      },
      geometries: 4,
      lane: "webgl",
      name: DIAGNOSTIC_EVENT_NAMES.viewport3DContextLost,
      severity: "critical",
      timestampMs: 30,
    });
  });
});
