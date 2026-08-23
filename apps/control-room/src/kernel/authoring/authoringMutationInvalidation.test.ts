import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH } from "@/kernel/api/apiPaths";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";

import {
  acknowledgedAuthoringSceneRevision,
  AUTHORING_MUTATION_DEPENDENTS,
  invalidateAuthoringMutationDependents,
} from "./authoringMutationInvalidation";

describe("authoring mutation readiness invalidation", () => {
  it("accepts only a scene revision acknowledged by the final mutation", () => {
    expect(
      acknowledgedAuthoringSceneRevision({ revision: 7, scene_revision: 8 }),
    ).toBe(8);
    expect(acknowledgedAuthoringSceneRevision({ revision: 7 })).toBe(7);
    expect(() => acknowledgedAuthoringSceneRevision({})).toThrow(
      "Authoring mutation ACK omitted the scene revision.",
    );
  });

  it.each([
    "../../modules/inspector/panels/ObjectMaterialPanel.tsx",
    "../../modules/inspector/panels/ObjectMagneticTexturePanel.tsx",
    "../../modules/inspector/panels/region/ObjectRegionTexturePanel.tsx",
    "./magnetization-texture/commands.ts",
  ])("routes %s through the bounded dependent helper", (relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

    expect(source).toContain("invalidateAuthoringMutationDependents");
    expect(source).toContain("acknowledgedAuthoringSceneRevision");
  });

  it.each(["material", "magnetization"] as const)(
    "invalidates readiness exactly once after a %s ACK without realtime",
    (kind) => {
      const invalidate = vi.fn();

      invalidateAuthoringMutationDependents({ invalidate }, kind, 17);

      expect(
        invalidate.mock.calls.filter(([resourceKey]) => resourceKey === MODEL_READINESS_PATH),
      ).toHaveLength(1);
      expect(
        invalidate.mock.calls.filter(
          ([resourceKey]) => resourceKey === SESSION_STATUS_RESOURCE_KEY,
        ),
      ).toHaveLength(1);
      expect(invalidate).toHaveBeenCalledTimes(
        AUTHORING_MUTATION_DEPENDENTS[kind].length,
      );
      expect(new Set(AUTHORING_MUTATION_DEPENDENTS[kind]).size).toBe(
        AUTHORING_MUTATION_DEPENDENTS[kind].length,
      );
    },
  );

});
