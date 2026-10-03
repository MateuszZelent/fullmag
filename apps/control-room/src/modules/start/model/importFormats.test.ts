import { describe, expect, it } from "vitest";

import { IMPORT_ACCEPT, classifyImportFile } from "./importFormats";

describe("classifyImportFile", () => {
  it("accepts a Fullmag archive regardless of case", () => {
    expect(classifyImportFile("YIG.FMS").kind).toBe("supported");
    expect(classifyImportFile("a.b.fms").kind).toBe("supported");
  });

  it("refuses a known format without an importer, naming it and the reason", () => {
    const result = classifyImportFile("sp4.mx3");
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reason).toContain("mumax³");
      expect(result.reason).toContain("cannot be imported yet");
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
