import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { translateMx3 } from "./mx3Import";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/mx3/${name}.mx3`, import.meta.url), "utf8");

const lines = (script: string) => script.split("\n");

describe("translateMx3: standard problem 4", () => {
  const result = translateMx3(fixture("standardproblem4"));

  it("translates every statement it understands, with arithmetic and variables", () => {
    expect(result.supported).toEqual([
      "L5: d := 500e-9",
      "L6: setgridsize(128, 32, 1)",
      "L7: setcellsize(d/128, 125e-9/32, 3e-9)",
      "L9: Msat = 800e3",
      "L10: Aex = 13e-12",
      "L11: alpha = 0.02",
      "L12: m = uniform(1, .1, 0)",
      "L14: relax()",
      "L17: TableAutosave(10e-12)",
      "L18: AutoSave(m, 100e-12)",
      "L19: B_ext = vector(-24.6e-3, 4.3e-3, 0)",
      "L20: run(1e-9)",
    ]);
  });

  it("reports the one statement it cannot map, with its line", () => {
    expect(result.unsupported).toEqual([
      {
        line: 15,
        text: "save(m)",
        reason: "a single-shot Save has no verified Fullmag mapping; use AutoSave(m, period)",
      },
    ]);
    expect(result.runnable).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("writes the report at the top and the SI model below it", () => {
    const script = result.script;
    expect(script.indexOf("# NOT TRANSLATED -- 1 statement.")).toBeGreaterThan(-1);
    expect(script).toContain("#   line 15: save(m)");
    expect(script.indexOf("# NOT TRANSLATED")).toBeLessThan(script.indexOf("import fullmag as fm"));
    expect(script).toContain("study.universe(mode=\"manual\", size=(5e-7, 1.25e-7, 3e-9)");
    expect(script).toContain("study.cell(3.90625e-9, 3.90625e-9, 3e-9)");
    expect(script).toContain("body.Ms = 800000.0");
    expect(script).toContain("body.Aex = 1.3e-11");
    expect(script).toContain("body.m = fm.texture.uniform(1.0, 0.1, 0.0)");
    expect(script).toContain("study.b_ext(-0.0246, 0.0043, 0.0)");
    expect(script).toContain("study.stages.add_run(1e-9)");
    expect(script).toContain('study.save("m", every=1e-10)');
    // B_ext is set after Relax(), so the relaxation is field-free, as in the original.
    expect(script.indexOf("add_relax(")).toBeLessThan(script.indexOf("study.b_ext("));
  });

  it("uses the public stage-first API and never the retired problem builder", () => {
    expect(result.script).toContain("fm.study(");
    expect(result.script).not.toContain("fm.Problem");
  });
});

describe("translateMx3: uniform relax with geometry and PBC", () => {
  const result = translateMx3(fixture("uniform_relax"));

  it("classifies all statements as supported", () => {
    expect(result.unsupported).toEqual([]);
    expect(result.supported).toEqual([
      "L2: SetGridSize(64, 64, 1)",
      "L3: SetCellSize(4e-9, 4e-9, 5e-9)",
      "L4: SetPBC(1, 1, 0)",
      "L5: SetGeom(Cylinder(200e-9, 5e-9))",
      "L7: Msat = 800e3",
      "L8: Aex = 13e-12",
      "L9: alpha = 1",
      "L11: m = RandomMag()",
      "L12: Relax()",
    ]);
    expect(result.script).toContain("# Every statement in the source was translated.");
  });

  it("maps the shape, the periodic axes and a visibly seeded random state", () => {
    expect(result.script).toContain('fm.Cylinder(radius=1e-7, height=5e-9, name="body")');
    expect(result.script).toContain(
      'study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(1, 1, 0))',
    );
    expect(result.script).toContain("fm.texture.random(seed=1)");
    expect(result.script).toContain("unseeded in mumax3");
  });
});

describe("translateMx3: anisotropic film", () => {
  const result = translateMx3(fixture("anisotropic_film"));

  it("maps anisotropy, DMI and the demag switch", () => {
    expect(result.unsupported).toEqual([]);
    expect(result.supported).toHaveLength(13);
    expect(result.script).toContain("body.Ku1 = 800000.0");
    expect(result.script).toContain("body.anisU = (0.0, 0.0, 1.0)");
    expect(result.script).toContain("body.Dind = 0.003");
    expect(result.script).toContain("study.demag()");
    expect(result.script).toContain("study.b_ext(0.0, 0.0, 0.02)");
  });
});

describe("translateMx3: constructs that must be reported, never dropped", () => {
  const result = translateMx3(fixture("spin_torque_sweep"));

  it("lists each refused statement with its line and reason", () => {
    expect(result.unsupported.map((item) => [item.line, item.text])).toEqual([
      [6, "DefRegion(1, Circle(60e-9))"],
      [10, "Xi = 0.05"],
      [11, "Pol = 1"],
      [12, "J = vector(1e12, 0, 0)"],
      [13, "Temp = 300"],
      [16, "ext_makegrains(40e-9, 256, 0)"],
      [18, "for i := 0; i < 3; i++ {"],
      [19, "B_ext = vector(i*1e-3, 0, 0)"],
      [20, "Run(1e-9)"],
      [21, "}"],
    ]);
    const reasons = Object.fromEntries(result.unsupported.map((item) => [item.line, item.reason]));
    expect(reasons[10]).toContain("spin-transfer torque");
    expect(reasons[13]).toContain("thermal");
    expect(reasons[16]).toContain("ext_");
    expect(reasons[19]).toContain("block");
  });

  it("keeps the translated part and repeats every refusal in the script header", () => {
    expect(result.supported).toEqual([
      "L3: SetGridSize(32, 32, 4)",
      "L4: SetCellSize(3.125e-9, 3.125e-9, 2.5e-9)",
      "L7: Msat = 800e3",
      "L8: Aex = 13e-12",
      "L9: alpha = 0.1",
      "L14: m = Vortex(1, 1)",
      "L17: Relax()",
      "L22: Run(2e-9)",
    ]);
    const header = result.script.slice(0, result.script.indexOf("import fullmag as fm"));
    for (const item of result.unsupported) {
      expect(header, `line ${item.line}`).toContain(`line ${item.line}: ${item.text}`);
    }
    expect(header).toContain("NOT TRANSLATED -- 10 statements.");
    expect(result.script).toContain("fm.texture.vortex(circulation=1, core_polarity=1)");
    // The refused run inside the loop produced no stage; only the top-level one did.
    expect(result.script.match(/add_run\(/g)).toHaveLength(1);
  });
});

describe("translateMx3: parsing rules", () => {
  const base = [
    "SetGridSize(8, 8, 1)",
    "SetCellSize(1e-9, 1e-9, 1e-9)",
    "Msat = 800e3",
    "Aex = 13e-12",
    "m = Uniform(1, 0, 0)",
    "Run(1e-12)",
  ].join("\n");

  it("ignores line and block comments, including trailing ones", () => {
    const result = translateMx3(
      `// header\n/* multi\nline */ ${base.split("\n")[0]} // trailing\n${base.split("\n").slice(1).join("\n")}`,
    );
    expect(result.unsupported).toEqual([]);
    expect(result.supported[0]).toBe("L3: SetGridSize(8, 8, 1)");
  });

  it("is case-insensitive about names, as mumax3 is", () => {
    const result = translateMx3(base.replace("Msat", "msat").replace("Aex", "AEX"));
    expect(result.unsupported).toEqual([]);
    expect(result.runnable).toBe(true);
  });

  it("evaluates arithmetic and refuses what it cannot evaluate", () => {
    const ok = translateMx3(base.replace("800e3", "(4e5 + 4e5) * 1"));
    expect(ok.unsupported).toEqual([]);
    expect(ok.script).toContain("body.Ms = 800000.0");

    const refused = translateMx3(base.replace("800e3", "sqrt(2)*1e6"));
    expect(refused.unsupported).toHaveLength(1);
    expect(refused.unsupported[0].line).toBe(3);
    expect(refused.unsupported[0].reason).toContain("function call");
    expect(refused.runnable).toBe(false);
    expect(refused.blockers.join(" ")).toContain("Msat");
  });

  it("refuses a material change between stages instead of applying it silently", () => {
    const result = translateMx3(`${base}\nalpha = 0.5\nRun(1e-12)`);
    expect(result.unsupported).toEqual([
      expect.objectContaining({ line: 7, text: "alpha = 0.5" }),
    ]);
    expect(result.unsupported[0].reason).toContain("between stages");
  });

  it("splits ; separated statements and joins calls that span lines", () => {
    const result = translateMx3(
      "SetGridSize(8,\n 8, 1); SetCellSize(1e-9, 1e-9, 1e-9)\nMsat = 800e3; Aex = 13e-12\nm = Uniform(1, 0, 0)\nRun(1e-12)",
    );
    expect(result.unsupported).toEqual([]);
    expect(result.supported).toHaveLength(6);
    expect(result.supported[0]).toBe("L1: SetGridSize(8, 8, 1)");
  });

  it("refuses a shape larger than the grid and a transformed shape", () => {
    const tooBig = translateMx3(`${base}\nSetGeom(Cuboid(1, 1, 1))`.replace("Run(1e-12)\n", ""));
    expect(tooBig.unsupported.some((item) => item.reason.includes("larger than the grid"))).toBe(true);

    const moved = translateMx3(base.replace("Run(1e-12)", "SetGeom(Circle(4e-9).Transl(1e-9, 0, 0))\nRun(1e-12)"));
    expect(moved.unsupported).toHaveLength(1);
    expect(moved.unsupported[0].reason).toContain("compound or transformed");
  });
});

describe("translateMx3: incomplete input", () => {
  it("emits a script that stops, and says what is missing", () => {
    const result = translateMx3("Msat = 800e3\n");
    expect(result.runnable).toBe(false);
    expect(result.blockers).toEqual([
      "no SetGridSize(...) was translated, so the mesh is unknown",
      "no SetCellSize(...) was translated, so the cell size is unknown",
      "Aex was not set to a plain number",
      "the initial magnetisation m was not set to a translatable value",
      "no Relax() or Run(...) was translated, so the script would compute nothing",
    ]);
    expect(result.script).toContain("# NOT RUNNABLE");
    expect(result.script).toContain("raise SystemExit(");
    expect(result.script).not.toContain("import fullmag");
  });

  it("returns a header-only script for an empty file", () => {
    const result = translateMx3("");
    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.runnable).toBe(false);
  });
});

// Optional: compile and load every generated script with the repository's Python
// package. Set FULLMAG_PYTHON to an interpreter and run from the repository.
const python = process.env.FULLMAG_PYTHON;
describe.runIf(Boolean(python))("generated scripts against the Python package", () => {
  const repoRoot = new URL("../../../../../../", import.meta.url);
  const pySrc = new URL("packages/fullmag-py/src", repoRoot);

  for (const name of ["standardproblem4", "uniform_relax", "anisotropic_film", "spin_torque_sweep"]) {
    it(`${name}.mx3 compiles and loads to ProblemIR`, () => {
      const dir = mkdtempSync(join(tmpdir(), "fullmag-mx3-"));
      try {
        const path = join(dir, `${name}.py`);
        writeFileSync(path, translateMx3(fixture(name)).script, "utf8");
        const env = { ...process.env, PYTHONPATH: fileURLToPath(pySrc) };
        const compile = spawnSync(python as string, ["-c", `import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())`, path], { env, encoding: "utf8" });
        expect(compile.status, compile.stderr).toBe(0);
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

describe("fixtures", () => {
  it("keep the script lines the tests cite", () => {
    expect(lines(fixture("standardproblem4"))[14]).toContain("save(m)");
  });
});
