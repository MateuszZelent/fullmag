import { describe, expect, it } from "vitest";
import { reconcileSpinAuthoringDraft } from "./spinAuthoringDraft";

describe("Spin Torque/Oersted raw draft reconciliation", () => {
  const baseline = { id: "A", degree: "0.4", beta: "0.01", target: '{"region":"a"}' };
  it("adopts independent server changes and preserves local spelling", () => {
    const result = reconcileSpinAuthoringDraft({ ...baseline, beta: "0.02" }, { ...baseline, degree: "5e-1" }, baseline);
    expect(result).toEqual({ draft: { ...baseline, beta: "0.02", degree: "5e-1" }, conflicts: [] });
  });
  it("keeps conflicting local and opaque text while naming the conflict", () => {
    const local = { ...baseline, target: '{ "region": "local" }' };
    expect(reconcileSpinAuthoringDraft({ ...baseline, target: '{"region":"server"}' }, local, baseline))
      .toEqual({ draft: local, conflicts: ["target"] });
  });
  it("does not conflict when server and local agree", () => {
    const next = { ...baseline, degree: "0.5" };
    expect(reconcileSpinAuthoringDraft(next, next, baseline)).toEqual({ draft: next, conflicts: [] });
  });
  it("merges an ACK against its submitted draft without discarding later edits", () => {
    const submitted = { ...baseline, degree: "0.5" };
    const later = { ...submitted, beta: "2e-2" };
    expect(reconcileSpinAuthoringDraft({ ...submitted, degree: "0.500" }, later, submitted))
      .toEqual({ draft: { ...later, degree: "0.500" }, conflicts: [] });
  });
});
