import { describe, expect, it } from "vitest";

import type { ModelReadinessResource } from "../api/apiTypes";
import {
  resolveRunAvailability,
  toChecklist,
} from "./scratchAuthoringReadiness";

function emptyReadiness(): ModelReadinessResource {
  return {
    blockers: ["Add at least one magnetic object."],
    capabilities: {
      move: { available: true, reason: null },
      rotate: {
        available: false,
        reason:
          "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.",
      },
      scale: {
        available: false,
        reason:
          "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.",
      },
    },
    checks: [
      { id: "study", label: "Study", reason: "Add a study stage.", state: "blocked" },
      { id: "geometry", label: "Geometry", reason: "Add at least one magnetic object.", state: "blocked" },
      { id: "texture", label: "Initial magnetization", reason: "Assign initial magnetization.", state: "blocked" },
      { id: "material", label: "Material", reason: "Assign a material.", state: "blocked" },
      { id: "discretization", label: "Discretization", reason: "Configure discretization.", state: "blocked" },
      { id: "interactions", label: "Interactions", reason: "Enable an interaction.", state: "blocked" },
    ],
    ready_to_export: false,
    ready_to_run: false,
    scene_revision: 0,
  };
}

describe("scratch authoring readiness presentation", () => {
  it("maps server checks to the stable product order without revalidating physics", () => {
    expect(toChecklist(emptyReadiness()).map((item) => [item.id, item.state])).toEqual([
      ["geometry", "blocked"],
      ["material", "blocked"],
      ["texture", "blocked"],
      ["interactions", "blocked"],
      ["discretization", "blocked"],
      ["study", "blocked"],
    ]);
  });

  it("uses the first server blocker as the Run disabled reason", () => {
    expect(resolveRunAvailability(emptyReadiness())).toEqual({
      enabled: false,
      reason: "Add at least one magnetic object.",
    });
  });

  it("enables Run only from the server ready_to_run decision", () => {
    expect(
      resolveRunAvailability({
        ...emptyReadiness(),
        blockers: [],
        ready_to_run: true,
      }),
    ).toEqual({ enabled: true, reason: null });
  });
});
