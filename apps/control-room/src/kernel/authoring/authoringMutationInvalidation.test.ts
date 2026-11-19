import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELDS_PATH,
  DATA_FIELD_META_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_OBSERVATION_FRAMES_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_READINESS_PATH,
  SIMULATION_PREPARATION_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  SIMULATION_STAGES_RESULTS_PATH,
} from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
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
    "../../modules/inspector/panels/PhysicsInteractionPanel.tsx",
    "./magnetization-texture/commands.ts",
  ])("routes %s through the bounded dependent helper", (relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

    expect(source).toContain("invalidateAuthoringMutationDependents");
    expect(source).toContain("acknowledgedAuthoringSceneRevision");
  });

  it.each(["geometry", "material", "magnetization", "interaction"] as const)(
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
      expect(invalidate).toHaveBeenCalledWith(MESHING_SHARED_DOMAIN_MANIFEST_PATH, "scene:17");
      expect(invalidate).toHaveBeenCalledTimes(
        AUTHORING_MUTATION_DEPENDENTS[kind].length + 1,
      );
      expect(new Set(AUTHORING_MUTATION_DEPENDENTS[kind]).size).toBe(
        AUTHORING_MUTATION_DEPENDENTS[kind].length,
      );
    },
  );

  it.each(["geometry", "material", "magnetization", "interaction"] as const)(
    "refreshes scoped live data and result freshness after a %s ACK",
    (kind) => {
      const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
      const scope = "session=A&epoch=A%401|";
      const keys = [
        DATA_FIELDS_PATH,
        DATA_FIELD_META_PATH.replace("{quantity_id}", "m"),
        DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m") + "?scope_kind=region&scope_id=r1",
        DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff"),
        DATA_FIELDS_PATH + "?stage_id=relax-a&run_id=run-a",
        DATA_FIELDS_PATH + "#viewport-3d:quantity-field-vectors:" + DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m"),
        DATA_FIELDS_PATH + "#viewport-3d:part-scalar-ranges:" + DATA_FIELD_META_PATH.replace("{quantity_id}", "H_eff"),
        DATA_OBSERVATION_FRAMES_PATH + "?limit=25",
        MESHING_SHARED_DOMAIN_MANIFEST_PATH,
        SIMULATION_STAGES_EXECUTION_PATH,
        SIMULATION_STAGES_RESULTS_PATH + "?stage_id=relax-a&limit=25",
      ];
      const callbacks = keys.map((key) => {
        const callback = vi.fn();
        resources.invalidate(scope + key, 900);
        resources.subscribe(scope + key, callback);
        return callback;
      });
      const previousResult = vi.fn();
      resources.subscribe(scope + "/v2/projects/p/persistence/solutions/run-a/study-state", previousResult);

      invalidateAuthoringMutationDependents(resources, kind, 17);

      for (const callback of callbacks) expect(callback).toHaveBeenCalledExactlyOnceWith("scene:17");
      expect(previousResult).not.toHaveBeenCalled();
    },
  );

  it("keeps material, texture, and interaction mutations off the mesh lifecycle", () => {
    expect(AUTHORING_MUTATION_DEPENDENTS.geometry).toContain(MESHING_BUILDS_CURRENT_PATH);
    for (const kind of ["material", "magnetization", "interaction"] as const) {
      expect(AUTHORING_MUTATION_DEPENDENTS[kind]).not.toContain(MESHING_BUILDS_CURRENT_PATH);
      expect(AUTHORING_MUTATION_DEPENDENTS[kind]).not.toContain(
        MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
      );
      expect(AUTHORING_MUTATION_DEPENDENTS[kind]).toContain(DATA_FIELDS_PATH);
    }
  });

  it.each(["geometry", "material", "magnetization", "interaction"] as const)(
    "invalidates the accepted preparation receipt after a %s mutation",
    (kind) => {
      expect(AUTHORING_MUTATION_DEPENDENTS[kind]).toContain(
        SIMULATION_PREPARATION_PATH,
      );
      const invalidate = vi.fn();

      invalidateAuthoringMutationDependents({ invalidate }, kind, 17);

      expect(invalidate).toHaveBeenCalledWith(
        SIMULATION_PREPARATION_PATH,
        "scene:17",
      );
    },
  );
});
