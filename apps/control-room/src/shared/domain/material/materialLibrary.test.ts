import { describe, expect, it } from "vitest";

import {
  MATERIAL_LIBRARY_PRESETS,
  materialNameToId,
  materialPresetIdToSceneMaterialId,
  materialPropertiesFromDraft,
  materialPropertiesToDraft,
  formatMaterialSourceChange,
  materialSourceChanges,
  materialSourceStatus,
} from "./materialLibrary";

describe("materialLibrary", () => {
  it("ships the canonical magnetic material presets with references", () => {
    expect(MATERIAL_LIBRARY_PRESETS.map((preset) => preset.id)).toEqual([
      "permalloy",
      "cofeb",
      "yig",
      "nickel",
      "iron",
    ]);
    for (const preset of MATERIAL_LIBRARY_PRESETS) {
      expect(preset.name).not.toBe("");
      expect(preset.properties.Ms).toEqual(expect.any(Number));
      expect(preset.properties.Aex).toEqual(expect.any(Number));
      expect(preset.properties.alpha).toEqual(expect.any(Number));
      expect(preset.references[0]?.url).toMatch(/^https:\/\/doi\.org\//);
    }
  });

  it("maps user and preset material names to scene material ids", () => {
    expect(materialPresetIdToSceneMaterialId("permalloy")).toBe("mat:permalloy");
    expect(materialNameToId("Permalloy Ni80Fe20")).toBe("mat:permalloy-ni80fe20");
    expect(materialNameToId("   ")).toBe("mat:material");
  });
});

const referenceProperties = { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 800000, alpha: 0.01 };
const referenceSource = {
  catalog_id: "builtin:permalloy", catalog_revision: 1, name: "Permalloy Ni80Fe20", kind: "builtin" as const,
  properties: referenceProperties, references: [{ url: "https://example.org/reference" }],
};

describe("material database editing and provenance", () => {
  it("rejects blank alpha instead of silently converting it to zero", () => {
    const result = materialPropertiesFromDraft({ Ms: "8e5", Aex: "1.3e-11", alpha: "  ", Dind: "", Dbulk: "" });
    expect(result).toHaveProperty("error", expect.stringContaining("alpha"));
  });

  it("keeps missing optional coefficients separate from zero and permits signed DMI", () => {
    expect(materialPropertiesFromDraft({ Ms: "", Aex: "", alpha: "0", Dind: "-0.001", Dbulk: "0" })).toEqual({
      properties: { Ms: null, Aex: null, alpha: 0, Dind: -0.001, Dbulk: 0 },
    });
  });

  it("compares numeric values rather than their input spelling", () => {
    const result = materialPropertiesFromDraft({ Ms: " 8.0e5 ", Aex: "0.000000000013", alpha: "0.010", Dind: "", Dbulk: "" });
    expect("properties" in result).toBe(true);
    if (!("properties" in result)) return;
    expect(materialSourceChanges(result.properties, referenceSource.references, referenceSource)).toEqual([]);
    expect(materialSourceStatus(result.properties, referenceSource.references, referenceSource)).toBe("unmodified");
  });

  it("lists changed coefficients with SI units using the saved baseline without fetching its parent", () => {
    const properties = { ...referenceProperties, Ms: 900000, alpha: 0.02 };
    const changes = materialSourceChanges(properties, referenceSource.references, referenceSource);
    expect(changes.map((change) => change.key)).toEqual(["Ms", "alpha"]);
    expect(changes.map((change) => change.unit)).toEqual(["A/m", "1"]);
    expect(materialSourceStatus(properties, referenceSource.references, referenceSource)).toBe("modified");
  });

  it("treats an extra reference as a change and leaves legacy materials without a claimed source", () => {
    const references = [...referenceSource.references, { citation: "Measured sample B" }];
    expect(materialSourceChanges(referenceProperties, references, referenceSource).map((change) => change.key)).toEqual(["references"]);
    expect(materialSourceStatus(referenceProperties, references, null)).toBe("unknown");
  });
});


describe("material database validation boundaries", () => {
  const validDraft = { Ms: "8e5", Aex: "1.3e-11", alpha: "0.01", Dind: "", Dbulk: "" };

  it.each(["-0.01", "NaN", "Infinity", "1e999", "word"])("rejects invalid damping %s", (alpha) => {
    expect(materialPropertiesFromDraft({ ...validDraft, alpha })).toHaveProperty("error", expect.stringContaining("alpha"));
  });

  it.each(["0", "-1", "Infinity"])("rejects invalid nonblank Ms %s", (Ms) => {
    expect(materialPropertiesFromDraft({ ...validDraft, Ms })).toHaveProperty("error", expect.stringContaining("Ms"));
  });

  it("allows zero exchange while rejecting negative exchange", () => {
    expect(materialPropertiesFromDraft({ ...validDraft, Aex: "0" })).toHaveProperty("properties.Aex", 0);
    expect(materialPropertiesFromDraft({ ...validDraft, Aex: "-1e-11" })).toHaveProperty("error", expect.stringContaining("Aex"));
  });

  it.each(["0x100", "0b101", "8,000", "1 000"])("rejects non-decimal numeric spelling %s", (Ms) => {
    expect(materialPropertiesFromDraft({ ...validDraft, Ms })).toHaveProperty("error", expect.stringContaining("Ms"));
  });

  it("round-trips all coefficients without changing absent values or signed DMI", () => {
    const properties = { Ms: null, Aex: 0, alpha: 0, Dind: -0.001, Dbulk: null };
    expect(materialPropertiesFromDraft(materialPropertiesToDraft(properties))).toEqual({ properties });
  });
});

describe("material source differences", () => {
  it("does not invent provenance for a matching name or matching coefficients", () => {
    expect(materialSourceStatus(referenceProperties, referenceSource.references, undefined)).toBe("unknown");
    expect(materialSourceChanges(referenceProperties, referenceSource.references, undefined)).toEqual([]);
  });

  it("compares every reference field and every reference entry", () => {
    const source = { ...referenceSource, references: [{ label: "First", url: "https://example.org/one", citation: "One" }, { citation: "Two" }] };
    for (const references of [
      [{ ...source.references[0], citation: "Changed" }, source.references[1]],
      [source.references[0]],
      [source.references[0], { citation: "Changed" }],
    ]) {
      expect(materialSourceChanges(referenceProperties, references, source)).toHaveLength(1);
      expect(materialSourceChanges(referenceProperties, references, source)[0]).toHaveProperty("key", "references");
    }
    expect(source.references[1]).toEqual({ citation: "Two" });
  });

  it("normalizes absent optional coefficients and optional reference fields", () => {
    const source = { ...referenceSource, references: [{ url: "https://example.org/reference", label: null }] };
    expect(materialSourceChanges({ Ms: 800000, Aex: 1.3e-11, alpha: 0.01 }, referenceSource.references, source)).toEqual([]);
  });

  it("describes changed reference contents even when the number of entries stays the same", () => {
    const source = { ...referenceSource, references: [{ citation: "Original measurement" }] };
    const changes = materialSourceChanges(referenceProperties, [{ citation: "New measurement" }], source);
    expect(formatMaterialSourceChange(changes[0])).toBe("References: Original measurement → New measurement");
  });

  it("labels bulk and interfacial DMI differences in J/m² and preserves the saved baseline", () => {
    const changes = materialSourceChanges({ ...referenceProperties, Dind: -0.001, Dbulk: 0 }, referenceSource.references, referenceSource);
    expect(changes).toEqual([
      { key: "Dind", label: "Dind", unit: "J/m²", before: null, after: -0.001 },
      { key: "Dbulk", label: "Dbulk", unit: "J/m²", before: null, after: 0 },
    ]);
    expect(formatMaterialSourceChange(changes[1])).toBe("Dbulk: Not set → 0 J/m²");
    expect(referenceSource.properties.Dbulk).toBeNull();
  });
});
