import { describe, expect, it } from "vitest";

import { parseComputeProbe } from "./computeProbe";

describe("parseComputeProbe", () => {
  it("reads a GPU host", () => {
    const probe = parseComputeProbe({
      gpus: [{ name: "RTX 4090", cuda_version: "12.4", vram_total: 24e9, vram_free: 18e9 }],
      cpu_threads: 32,
      preferred_backend: "cuda",
      warnings: ["driver is old"],
    });
    expect(probe).toEqual({
      gpus: [
        {
          name: "RTX 4090",
          cudaVersion: "12.4",
          vramTotalBytes: 24e9,
          vramFreeBytes: 18e9,
          busyWithRun: undefined,
        },
      ],
      cpuThreads: 32,
      preferredBackend: "cuda",
      warnings: ["driver is old"],
    });
  });

  it("reports a CPU-only host as such", () => {
    const probe = parseComputeProbe({ gpus: [], cpu_threads: 8, preferred_backend: "cpu" });
    expect(probe?.gpus).toEqual([]);
    expect(probe?.preferredBackend).toBe("cpu");
  });

  it("drops a GPU without memory figures instead of inventing them", () => {
    const probe = parseComputeProbe({
      gpus: [{ name: "Mystery" }, { name: "Ok", vram_total: 10, vram_free: 99 }],
      cpu_threads: 4,
    });
    expect(probe?.gpus).toHaveLength(1);
    expect(probe?.gpus[0]?.vramFreeBytes).toBe(10);
  });

  it("never claims CUDA without a GPU", () => {
    const probe = parseComputeProbe({ gpus: [], cpu_threads: 4, preferred_backend: "cuda" });
    expect(probe?.preferredBackend).toBe("cpu");
  });

  it("treats unusable input as no probe", () => {
    expect(parseComputeProbe(null)).toBeNull();
    expect(parseComputeProbe({ gpus: [] })).toBeNull();
    expect(parseComputeProbe({ cpu_threads: 0 })).toBeNull();
  });
});
