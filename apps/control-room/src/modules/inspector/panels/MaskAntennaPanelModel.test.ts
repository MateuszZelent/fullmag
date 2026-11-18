import { describe, expect, it, vi } from "vitest";

import type {
  MaskFieldDriveResource,
  MaskTermResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  addTerm,
  addTermParameter,
  commitMaskAntenna,
  createMaskAntennaDraft,
  maskAntennaSummary,
  MAX_MASK_TERMS,
  mergeMaskAntennaDraft,
  readyAntennaCalls,
  removeTerm,
  replaceReadyAntennaCall,
  resolveMaskAntennaPanelModel,
  sameJson,
  setTermLocal,
  setTermOutput,
  setTermParameter,
  setTermStatic,
  validateMaskAntennaDraft,
} from "./MaskAntennaPanelModel";

function readyTerm(amplitude: number, callIndex = 0): MaskTermResource {
  return {
    mask: {
      function: {
        expression_version: "field_expr.v1",
        locals: [
          { expression: "2 * pi / wavelength", name: "k" },
          { expression: "exp(-(x - center_x) ^ 2 / (2 * wavelength ^ 2))", name: "g" },
        ],
        name: "gaussian_k_source_mask",
        outputs: ["amplitude * g * sin(k * x - pi / 2)", "0.0", "amplitude * g * sin(k * x)"],
        parameters: [
          { name: "amplitude", value: amplitude },
          { name: "wavelength", value: 2.79e-7 },
          { name: "center_x", value: -2.6e-6 },
        ],
      },
      kind: "function",
    },
    origin: {
      arguments: { amplitude, center_x: -2.6e-6, wavelength: 2.79e-7 },
      call_index: callIndex,
      function: "fullmag.antennas.gaussian_k_source",
      output_index: 0,
    },
    time: {
      expression_version: "field_expr.v1",
      name: "delayed_sine",
      outputs: ["sin(2 * pi * frequency * (t - t0))"],
      parameters: [{ name: "frequency", value: 3.6e9 }, { name: "t0", value: 0 }],
    },
  };
}

function antenna(terms: MaskTermResource[]): MaskFieldDriveResource {
  return { ...createMaskAntennaDraft([]), terms };
}

const selection = (ref: Partial<NonNullable<Selection["ref"]>>): Selection => ({
  kind: "physics.field-drive",
  label: "Antenna",
  nodeId: "node",
  objectId: null,
  ref: {
    fieldDriveKind: "mask",
    kind: "physics.field-drive",
    nodeId: "node",
    type: "physics-field-drive",
    ...ref,
  } as NonNullable<Selection["ref"]>,
});

describe("mask antenna panel model", () => {
  it("creates a draft with a free id and one sine-driven term", () => {
    const draft = createMaskAntennaDraft(["mask-antenna", "mask-antenna-2"], "film");
    expect(draft.id).toBe("mask-antenna-3");
    expect(draft.schema_version).toBe("mask_field_drive.v1");
    expect(draft.target).toEqual({ kind: "object", object_id: "film" });
    expect(draft.terms).toHaveLength(1);
    expect(draft.terms[0].time?.outputs).toEqual(["sin(2 * pi * f * t)"]);
    expect(validateMaskAntennaDraft(draft)).toEqual([]);
  });

  it("resolves create, found and missing selections", () => {
    const existing = antenna([readyTerm(2e-4)]);
    const resource = { drives: [existing], scene_revision: 7 };
    expect(resolveMaskAntennaPanelModel(selection({ draft: true }), resource, ["mask-antenna-2"]))
      .toMatchObject({ mode: "create", sceneRevision: 7, drive: { id: "mask-antenna-3" } });
    expect(resolveMaskAntennaPanelModel(selection({ fieldDriveId: existing.id }), resource))
      .toMatchObject({ mode: "found", drive: existing });
    expect(resolveMaskAntennaPanelModel(selection({ fieldDriveId: "gone" }), resource).mode)
      .toBe("missing");
  });

  it("changing a parameter value keeps locals, outputs and other terms, and detaches the term", () => {
    const drive = antenna([readyTerm(2e-4), readyTerm(1e-4, 1)]);
    const updated = setTermParameter(drive, 0, "mask", "amplitude", 3e-4);
    const before = drive.terms[0].mask;
    const after = updated.terms[0].mask;
    if (before.kind !== "function" || after.kind !== "function") throw new Error("function masks");
    expect(after.function.parameters?.[0]).toEqual({ name: "amplitude", value: 3e-4 });
    expect(after.function.locals).toEqual(before.function.locals);
    expect(after.function.outputs).toEqual(before.function.outputs);
    expect(updated.terms[0].origin).toBeUndefined();
    expect(updated.terms[1]).toBe(drive.terms[1]);
    expect(drive.terms[0].origin).toBeDefined();
  });

  it("edits one local or output without reordering the others", () => {
    const drive = antenna([readyTerm(2e-4)]);
    const local = setTermLocal(drive, 0, "mask", 1, "exp(-x ^ 2)");
    const output = setTermOutput(local, 0, "time", 0, "cos(2 * pi * frequency * t)");
    const mask = output.terms[0].mask;
    if (mask.kind !== "function") throw new Error("function mask");
    expect(mask.function.locals?.map((item) => item.name)).toEqual(["k", "g"]);
    expect(mask.function.locals?.[1].expression).toBe("exp(-x ^ 2)");
    expect(output.terms[0].time?.outputs).toEqual(["cos(2 * pi * frequency * t)"]);
  });

  it("adds terms up to the limit and removes one without touching the rest", () => {
    let drive = antenna([readyTerm(2e-4)]);
    for (let index = 0; index < 12; index += 1) drive = addTerm(drive);
    expect(drive.terms).toHaveLength(MAX_MASK_TERMS);
    const kept = drive.terms[2];
    expect(removeTerm(drive, 1).terms[1]).toBe(kept);
  });

  it("toggles a term between static and time-dependent", () => {
    const drive = antenna([readyTerm(2e-4)]);
    const fixed = setTermStatic(drive, 0, true);
    expect(fixed.terms[0].time).toBeUndefined();
    expect(setTermStatic(fixed, 0, false).terms[0].time?.name).toBe("sine");
  });

  it("groups terms by ready-antenna call and replaces only that call's terms", () => {
    const plain = createMaskAntennaDraft([]).terms[0];
    const drive = antenna([readyTerm(2e-4), plain, readyTerm(1e-4, 1)]);
    expect(readyAntennaCalls(drive).map((call) => [call.callIndex, call.termIndices]))
      .toEqual([[0, [0]], [1, [2]]]);
    const rebuilt = replaceReadyAntennaCall(drive, 1, [readyTerm(5e-4)]);
    expect(rebuilt.terms[0]).toBe(drive.terms[0]);
    expect(rebuilt.terms[1]).toBe(plain);
    expect(rebuilt.terms[2].origin).toMatchObject({ call_index: 1, arguments: { amplitude: 5e-4 } });
    const appended = replaceReadyAntennaCall(drive, null, [readyTerm(7e-4)]);
    expect(appended.terms).toHaveLength(4);
    expect(appended.terms[3].origin?.call_index).toBe(2);
  });

  it("reports local problems; equations are left to the server", () => {
    const drive = antenna([{ ...readyTerm(2e-4), name: "1st" }]);
    const errors = validateMaskAntennaDraft({
      ...drive,
      name: " ",
      shape: { center: [0, 0, 0], kind: "box", size: [1e-7, 0, 1e-7] },
      target: { kind: "region", object_id: "film", region_id: "" },
    });
    expect(errors).toEqual([
      "The antenna needs a name.",
      "Select the target region.",
      "The box size must be positive.",
      "Term 1: the name must be an identifier.",
    ]);
  });

  it("refuses Python keywords as parameter names, since the script writes them", () => {
    const term = readyTerm(2e-4);
    if (term.mask.kind !== "function") throw new Error("function mask expected");
    const renamed: MaskTermResource = {
      ...term,
      mask: {
        ...term.mask,
        function: {
          ...term.mask.function,
          parameters: [{ name: "lambda", value: 2.79e-7 }],
        },
      },
    };
    expect(validateMaskAntennaDraft(antenna([renamed]))).toEqual([
      "Term 1: parameter 'lambda' must be an identifier that is not a Python keyword.",
    ]);
  });

  it("summarises an antenna for the list", () => {
    expect(maskAntennaSummary(antenna([readyTerm(2e-4), createMaskAntennaDraft([]).terms[0]])))
      .toBe("2 terms · 1 ready antenna · active");
  });

  it("creates a new antenna and replaces an existing one", async () => {
    const api = {
      createMaskFieldDrive: vi.fn().mockResolvedValue({ scene_revision: 8 }),
      replaceMaskFieldDrive: vi.fn().mockResolvedValue({ scene_revision: 9 }),
    };
    const drive = antenna([readyTerm(2e-4)]);
    await commitMaskAntenna(api, "create", 7, drive);
    expect(api.createMaskFieldDrive).toHaveBeenCalledWith({ base_revision: 7, drive }, undefined);
    await commitMaskAntenna(api, "found", 8, drive, { sessionScopeKey: "s" });
    expect(api.replaceMaskFieldDrive).toHaveBeenCalledWith(
      drive.id,
      { base_revision: 8, drive },
      { sessionScopeKey: "s" },
    );
  });

  it("setting a parameter to its current value keeps the term and its origin", () => {
    const drive = antenna([readyTerm(2e-4)]);
    expect(setTermParameter(drive, 0, "mask", "amplitude", 2e-4)).toBe(drive);
  });
});

describe("mask antenna draft merge", () => {
  it("compares JSON by structure, ignoring key order and null against missing", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1, name: null }, { a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 0 }, { a: null })).toBe(false);
  });

  it("takes each side's change of different fields", () => {
    const base = antenna([readyTerm(2e-4)]);
    const mine = setTermOutput(base, 0, "mask", 2, "amplitude * g");
    const theirs = { ...base, name: "Renamed", position_m: [0, 1e-7, 0] };
    const { conflicts, merged } = mergeMaskAntennaDraft(base, mine, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.name).toBe("Renamed");
    expect(merged.position_m).toEqual([0, 1e-7, 0]);
    expect(merged.terms[0].mask.kind === "function" && merged.terms[0].mask.function.outputs[2])
      .toBe("amplitude * g");
    // The edited term no longer equals the ready antenna's output.
    expect(merged.terms[0].origin).toBeUndefined();
  });

  it("follows the scene where the draft equals its base", () => {
    const base = antenna([readyTerm(2e-4)]);
    const theirs = setTermParameter(base, 0, "mask", "amplitude", 5e-4);
    expect(mergeMaskAntennaDraft(base, structuredClone(base), theirs)).toEqual({ conflicts: [], merged: theirs });
  });

  it("reports a field both sides changed and keeps the draft's value there", () => {
    const base = antenna([readyTerm(2e-4)]);
    const mine = setTermOutput(base, 0, "mask", 2, "amplitude * g");
    const theirs = setTermParameter(setTermOutput(base, 0, "mask", 2, "2 * amplitude * g"), 0, "time", "t0", 1e-9);
    const { conflicts, merged } = mergeMaskAntennaDraft(base, mine, theirs);
    expect(conflicts).toEqual(["drive.terms[0].mask.function.outputs[2]"]);
    const term = merged.terms[0];
    expect(term.mask.kind === "function" && term.mask.function.outputs[2]).toBe("amplitude * g");
    expect(term.time?.parameters?.[1]).toEqual({ name: "t0", value: 1e-9 });
  });

  it("merges parameters by name when the scene reorders them", () => {
    const base = antenna([readyTerm(2e-4)]);
    const mine = setTermParameter(base, 0, "mask", "amplitude", 3e-4);
    const theirs = structuredClone(base);
    const theirMask = theirs.terms[0].mask;
    if (theirMask.kind !== "function" || !theirMask.function.parameters) throw new Error("a function mask");
    theirMask.function.parameters.reverse();
    const { conflicts, merged } = mergeMaskAntennaDraft(base, mine, theirs);
    expect(conflicts).toEqual([]);
    const mask = merged.terms[0].mask;
    expect(mask.kind === "function" && mask.function.parameters).toEqual([
      { name: "center_x", value: -2.6e-6 },
      { name: "wavelength", value: 2.79e-7 },
      { name: "amplitude", value: 3e-4 },
    ]);
  });

  it("keeps a parameter the draft added beside one the scene changed", () => {
    const base = antenna([readyTerm(2e-4)]);
    const mine = addTermParameter(base, 0, "time", "phase");
    const theirs = setTermParameter(base, 0, "time", "frequency", 4e9);
    const { conflicts, merged } = mergeMaskAntennaDraft(base, mine, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.terms[0].time?.parameters?.map((parameter) => parameter.name)).toEqual(["frequency", "t0", "phase"]);
    expect(merged.terms[0].time?.parameters?.[0]).toEqual({ name: "frequency", value: 4e9 });
  });

  it("treats a list whose length changed on one side and was edited on the other as a conflict", () => {
    const base = antenna([readyTerm(2e-4)]);
    const mine = addTerm(base);
    const theirs = setTermParameter(base, 0, "mask", "amplitude", 5e-4);
    const { conflicts, merged } = mergeMaskAntennaDraft(base, mine, theirs);
    expect(conflicts).toEqual(["drive.terms"]);
    expect(merged.terms).toEqual(mine.terms);
  });
});
