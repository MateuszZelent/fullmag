import { describe, expect, it } from "vitest";

import { buildDiagnostics } from "./diagnostics";
import type { ComputeEnvironment, RecentIndexState } from "./types";

const base = {
  host: "desktop" as const,
  userAgent: "UA",
  locale: "pl-PL",
  now: new Date("2026-10-03T12:00:00Z"),
  build: null,
};

describe("buildDiagnostics", () => {
  it("reports an unavailable index and an unprobed host plainly", () => {
    const text = buildDiagnostics({ ...base, index: { kind: "unavailable" }, compute: null });
    expect(text).toContain("Captured: 2026-10-03T12:00:00.000Z");
    expect(text).toContain("Recent index: unavailable");
    expect(text).toContain("Compute: not probed (no host support)");
    expect(text).toContain("Build: not exposed to the renderer");
  });

  it("reports the host build when there is one", () => {
    const text = buildDiagnostics({
      ...base,
      build: { version: "0.1.0", os: "windows", arch: "x86_64", profile: "release", projectSchema: "s" },
      index: { kind: "empty" },
      compute: null,
    });
    expect(text).toContain("Build: 0.1.0 (release), windows/x86_64, project schema s");
  });

  it("includes index size and the GPU", () => {
    const index: RecentIndexState = {
      kind: "ready",
      index: { formatVersion: 1, generatedAt: "t", entries: [] },
    };
    const compute: ComputeEnvironment = {
      gpus: [{ name: "RTX 4090", cudaVersion: "12.4", vramTotalBytes: 24e9, vramFreeBytes: 18e9 }],
      cpuThreads: 32,
      preferredBackend: "cuda",
      warnings: ["driver is old"],
    };
    const text = buildDiagnostics({ ...base, index, compute });
    expect(text).toContain("ready, 0 projects, generated t");
    expect(text).toContain("GPU: RTX 4090, CUDA 12.4, 18000 / 24000 MB free");
    expect(text).toContain("warning: driver is old");
  });

  it("says when no GPU is present", () => {
    const compute: ComputeEnvironment = {
      gpus: [],
      cpuThreads: 8,
      preferredBackend: "cpu",
      warnings: [],
    };
    expect(buildDiagnostics({ ...base, index: { kind: "empty" }, compute })).toContain(
      "GPU: none detected",
    );
  });
});
