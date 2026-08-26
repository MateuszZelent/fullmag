import { describe, expect, it } from "vitest";

import {
  parsePreparationFailurePredicates,
  resolvePreparationFailureCauses,
} from "./simulationPreparationModel";

describe("simulation preparation failure predicates", () => {
  it("explains the mixed-P1 GPU DMI predicate with an actionable CPU alternative", () => {
    const causes = resolvePreparationFailureCauses(
      "failed_predicates=[gpu_dmi_kernel_not_mixed_p1]",
    );

    expect(causes).toEqual([
      expect.objectContaining({
        action: expect.stringContaining("FEM CPU"),
        known: true,
        label: expect.stringContaining("GPU"),
        predicate: "gpu_dmi_kernel_not_mixed_p1",
      }),
    ]);
  });

  it("explains the known material-field predicate", () => {
    const causes = resolvePreparationFailureCauses(
      "fem_mixed_p1_scope_rejected: failed_predicates=[unsupported_material_field_or_dmi]",
    );

    expect(causes[0]).toEqual(
      expect.objectContaining({
        action: expect.stringContaining("uniform"),
        known: true,
        predicate: "unsupported_material_field_or_dmi",
      }),
    );
  });

  it("keeps all predicates from a bounded multi-predicate list", () => {
    const causes = resolvePreparationFailureCauses(
      "failed_predicates=[unsupported_material_field_or_dmi,gpu_dmi_kernel_not_mixed_p1]",
    );

    expect(causes.map((cause) => cause.predicate)).toEqual([
      "unsupported_material_field_or_dmi",
      "gpu_dmi_kernel_not_mixed_p1",
    ]);
  });

  it("keeps an unknown predicate visible with a safe fallback explanation", () => {
    const causes = resolvePreparationFailureCauses(
      "failed_predicates=[future_mixed_p1_constraint]",
    );

    expect(causes[0]).toEqual({
      action: expect.stringContaining("raw diagnostic"),
      known: false,
      label: "Unknown preparation constraint",
      predicate: "future_mixed_p1_constraint",
    });
  });

  it("bounds the parsed predicate list without dropping the truncation signal", () => {
    const detail = `failed_predicates=[${Array.from(
      { length: 40 },
      (_, index) => `predicate_${index}`,
    ).join(",")}]`;

    const parsed = parsePreparationFailurePredicates(detail);

    expect(parsed.predicates).toHaveLength(32);
    expect(parsed.omittedCount).toBe(8);
  });
});
