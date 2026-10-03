import { describe, expect, it } from "vitest";

import { describeCompute, describeIndexCount } from "./StartStatusBar";

describe("describeCompute", () => {
  it("says nothing for an unprobed host", () => {
    expect(describeCompute(null)).toBeNull();
    expect(describeCompute(undefined)).toBeNull();
  });

  it("summarises a GPU host", () => {
    expect(
      describeCompute({
        gpus: [{ name: "RTX 4090", cudaVersion: "12.4", vramTotalBytes: 24e9, vramFreeBytes: 18.2e9 }],
        cpuThreads: 32,
        preferredBackend: "cuda",
        warnings: [],
      }),
    ).toBe("CUDA 12.4 · RTX 4090 · 5.8/24.0 GB");
  });

  it("reports a CPU-only host without inventing a GPU", () => {
    expect(
      describeCompute({ gpus: [], cpuThreads: 8, preferredBackend: "cpu", warnings: [] }),
    ).toBe("CPU only · 8 threads");
  });
});

describe("describeIndexCount", () => {
  it("counts projects only from a ready index", () => {
    expect(describeIndexCount({ kind: "loading" })).toBeNull();
    expect(
      describeIndexCount({
        kind: "ready",
        index: { formatVersion: 1, generatedAt: "", entries: [] },
      }),
    ).toBe("0 projects indexed");
  });
});
