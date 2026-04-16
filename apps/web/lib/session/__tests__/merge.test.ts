import { describe, expect, it } from "vitest";

import type { ScalarRow } from "../types";
import { mergeScalarRowsDelta } from "../merge";

function row(step: number, overrides: Partial<ScalarRow> = {}): ScalarRow {
  return {
    step,
    time: step * 1e-12,
    solver_dt: 1e-14,
    mx: 0,
    my: 0,
    mz: 1,
    e_ex: step,
    e_demag: step,
    e_ext: step,
    e_ani: 0,
    e_dmi: 0,
    e_total: step,
    max_dm_dt: step + 0.5,
    max_h_eff: step + 1,
    max_h_demag: 0,
    max_torque_Apm: 0,
    max_torque_T: 0,
    ...overrides,
  };
}

describe("mergeScalarRowsDelta", () => {
  it("appends pure delta rows", () => {
    const merged = mergeScalarRowsDelta(
      [row(1), row(2)],
      [row(3), row(4)],
      4,
      null,
    );

    expect(merged.map((entry) => entry.step)).toEqual([1, 2, 3, 4]);
  });

  it("replaces the live tip when the same step arrives again", () => {
    const merged = mergeScalarRowsDelta(
      [row(1), row(2, { e_total: 2, max_dm_dt: 2.5 })],
      [row(2, { e_total: 20, max_dm_dt: 200.5 })],
      2,
      null,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]?.step).toBe(2);
    expect(merged[1]?.e_total).toBe(20);
    expect(merged[1]?.max_dm_dt).toBe(200.5);
  });

  it("replaces the overlapping tip and appends new rows", () => {
    const merged = mergeScalarRowsDelta(
      [row(1), row(2, { e_total: 2 })],
      [row(2, { e_total: 22 }), row(3, { e_total: 33 })],
      3,
      null,
    );

    expect(merged.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(merged[1]?.e_total).toBe(22);
    expect(merged[2]?.e_total).toBe(33);
  });

  it("keeps the full history when the caller opts out of the live cap", () => {
    const prevRows = Array.from({ length: 10_000 }, (_, index) => row(index));
    const nextRows = [row(10_000)];

    const merged = mergeScalarRowsDelta(prevRows, nextRows, 10_001, null);

    expect(merged).toHaveLength(10_001);
    expect(merged[0]?.step).toBe(0);
    expect(merged[10_000]?.step).toBe(10_000);
  });
});
