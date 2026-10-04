import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { STUDY_TEMPLATES, estimateFor } from "./templates";
import type { ComputeEnvironment } from "./types";

const template = (id: string) => {
  const found = STUDY_TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`missing template ${id}`);
  return found;
};

const gpuHost = (vramGb: number): ComputeEnvironment => ({
  gpus: [{ name: "RTX 4090", vramTotalBytes: vramGb * 1e9, vramFreeBytes: vramGb * 1e9 }],
  cpuThreads: 32,
  preferredBackend: "cuda",
  warnings: [],
});

const cpuHost = (threads: number): ComputeEnvironment => ({
  gpus: [],
  cpuThreads: threads,
  preferredBackend: "cpu",
  warnings: [],
});

describe("STUDY_TEMPLATES", () => {
  it("ships the eight studies with unique ids", () => {
    expect(STUDY_TEMPLATES).toHaveLength(8);
    expect(new Set(STUDY_TEMPLATES.map((t) => t.id)).size).toBe(8);
  });
});

describe("template documentation links", () => {
  // The links are only worth showing while the page exists in the docs source.
  const docsSource = new URL("../../../../../../public_docs/site/", import.meta.url);

  it("point at pages that exist in the Sphinx source", () => {
    for (const t of STUDY_TEMPLATES) {
      expect(t.docsPage.endsWith(".html"), t.id).toBe(true);
      const source = new URL(t.docsPage.replace(/\.html$/, ".md"), docsSource);
      expect(existsSync(source), `${t.id} -> ${t.docsPage}`).toBe(true);
    }
  });
});

describe("estimateFor", () => {
  it("reads GPU figures on a GPU host with enough memory", () => {
    const label = estimateFor(template("spin-wave-dispersion"), gpuHost(24));
    expect(label).toMatchObject({ basis: "gpu", text: "~25 min · 6 GB VRAM" });
  });

  it("switches to CPU figures on a machine without a GPU", () => {
    const label = estimateFor(template("spin-wave-dispersion"), cpuHost(32));
    expect(label).toMatchObject({ basis: "cpu", text: "~7 h · CPU ×32" });
    expect(label.note).toContain("No GPU");
  });

  it("scales the CPU figure to the thread count", () => {
    expect(estimateFor(template("umag-sp1"), cpuHost(8)).text).toBe("~1.7 h · CPU ×8");
  });

  it("falls back to the CPU figure when the GPU is too small", () => {
    const label = estimateFor(template("skyrmion-phase-diagram"), gpuHost(4));
    expect(label.basis).toBe("cpu");
    expect(label.note).toContain("less than");
  });

  it("uses the labelled reference figure when the machine was not probed", () => {
    const label = estimateFor(template("umag-sp4"), null);
    expect(label.basis).toBe("reference");
    expect(label.text).toBe("~1 min · 0.3 GB VRAM");
    expect(estimateFor(template("umag-sp4"), undefined).basis).toBe("reference");
  });
});
