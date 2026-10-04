import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { STUDY_TEMPLATES, estimateFor, templateScript, templateScriptFileName } from "./templates";
import { TEMPLATE_SCRIPTS } from "./templateScripts";
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

describe("template scripts", () => {
  it("ship one script per template and none for an unknown id", () => {
    expect(Object.keys(TEMPLATE_SCRIPTS).sort()).toEqual(STUDY_TEMPLATES.map((t) => t.id).sort());
    for (const t of STUDY_TEMPLATES) {
      expect(templateScript(t), t.id).toBe(TEMPLATE_SCRIPTS[t.id]);
      expect(templateScriptFileName(t)).toBe(`${t.id}.py`);
    }
    expect(templateScript({ ...STUDY_TEMPLATES[0], id: "constructor" })).toBeNull();
  });

  it("use the stage-first study API with a declared engine and no retired builder", () => {
    for (const t of STUDY_TEMPLATES) {
      const script = templateScript(t) ?? "";
      expect(script, t.id).toContain("import fullmag as fm");
      expect(script, t.id).toContain("fm.study(");
      expect(script, t.id).toContain(`study.engine("${t.solver.toLowerCase()}")`);
      expect(script, t.id).not.toContain("fm.Problem");
      // Requested intent stays visible; the resolved device is recorded at run time.
      expect(script, t.id).toContain('study.device("auto", precision="double")');
      expect(script, t.id).toMatch(/study\.stages\.add_/);
    }
  });
});

// Optional: execute each script against the repository's Python package (loader only,
// no solver). Set FULLMAG_PYTHON to an interpreter.
const python = process.env.FULLMAG_PYTHON;
describe.runIf(Boolean(python))("template scripts against the Python package", () => {
  for (const t of STUDY_TEMPLATES) {
    it(`${t.id} compiles and lowers to ProblemIR`, () => {
      const dir = mkdtempSync(join(tmpdir(), "fullmag-template-"));
      try {
        const path = join(dir, templateScriptFileName(t));
        writeFileSync(path, templateScript(t) ?? "", "utf8");
        const env = {
          ...process.env,
          PYTHONPATH: fileURLToPath(new URL("../../../../../../packages/fullmag-py/src", import.meta.url)),
        };
        const load = spawnSync(
          python as string,
          ["-m", "fullmag.runtime.helper", "export-run-config", "--skip-geometry-assets", "--script", path],
          { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        expect(load.status, load.stderr.slice(-800)).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
