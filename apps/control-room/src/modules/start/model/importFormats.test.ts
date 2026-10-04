import { describe, expect, it } from "vitest";

import { IMPORT_ACCEPT, classifyImportFile } from "./importFormats";

describe("classifyImportFile", () => {
  it("accepts a Fullmag archive regardless of case", () => {
    expect(classifyImportFile("YIG.FMS").kind).toBe("supported");
    expect(classifyImportFile("a.b.fms").kind).toBe("supported");
  });

  it("accepts a mumax3 script as a partial import", () => {
    const result = classifyImportFile("sp4.MX3");
    expect(result.kind).toBe("supported");
    if (result.kind === "supported") {
      expect(result.format.id).toBe("mx3");
      expect(result.format.partial).toBe(true);
    }
  });

  it("refuses a known format without an importer, naming it and the reason", () => {
    for (const [file, label] of [["sim.mif", "OOMMF"], ["model.mph", "COMSOL"], ["geom.stl", "Mesh"]] as const) {
      const result = classifyImportFile(file);
      expect(result.kind, file).toBe("unsupported");
      if (result.kind === "unsupported") {
        expect(result.reason).toContain(label);
        expect(result.reason).toContain("cannot be imported yet");
      }
    }
  });

  it("refuses an unknown extension and a file with none", () => {
    expect(classifyImportFile("notes.txt")).toMatchObject({ kind: "unknown" });
    expect(classifyImportFile("README")).toMatchObject({ kind: "unknown" });
  });

  it("offers every known extension to the file chooser", () => {
    expect(IMPORT_ACCEPT).toContain(".fms");
    expect(IMPORT_ACCEPT).toContain(".mx3");
    expect(IMPORT_ACCEPT).toContain(".npy");
  });
});
