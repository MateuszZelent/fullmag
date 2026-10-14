import { describe, expect, it } from "vitest";

import type { ModelReadinessResource } from "../api/apiTypes";
import {
  resolveRunAvailability,
  toChecklist,
} from "./scratchAuthoringReadiness";
import { resolveScratchAuthoringAction } from "./scratchAuthoringGuideModel";

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
      { id: "execution", label: "Execution", reason: "Choose a run device.", state: "blocked", target_resource: "model/study" },
      { id: "study", label: "Study", reason: "Add a study stage.", state: "blocked" },
      { id: "domain", label: "Domain", reason: "Configure the domain.", state: "blocked", target_resource: "meshing/policies/universe" },
      { id: "geometry", label: "Geometry", reason: "Add at least one magnetic object.", state: "blocked" },
      { id: "texture", label: "Initial magnetization", reason: "Assign initial magnetization.", state: "blocked" },
      { id: "material", label: "Material", reason: "Assign a material.", state: "blocked" },
      { id: "discretization", label: "Discretization", reason: "Configure discretization.", state: "blocked" },
      { id: "interactions", label: "Interactions", reason: "Enable an interaction.", state: "blocked" },
      { id: "method", label: "Method", reason: "Choose a method.", state: "blocked", target_resource: "model/study" },
    ],
    ready_to_export: false,
    ready_to_run: false,
    scene_revision: 0,
  };
}

describe("scratch authoring readiness presentation", () => {
  it("orders known server checks and retains unknown checks after them", () => {
    expect(toChecklist(emptyReadiness()).map((item) => [item.id, item.state])).toEqual([
      ["method", "blocked"],
      ["domain", "blocked"],
      ["geometry", "blocked"],
      ["material", "blocked"],
      ["texture", "blocked"],
      ["interactions", "blocked"],
      ["discretization", "blocked"],
      ["study", "blocked"],
      ["execution", "blocked"],
    ]);
  });

  it("preserves unknown checks, target resources, stale state, and the server revision", () => {
    const readiness = {
      ...emptyReadiness(),
      checks: [
        ...emptyReadiness().checks,
        {
          id: "future-authoring-check",
          label: "Future check",
          reason: "A future route needs review.",
          state: "stale" as const,
          target_resource: "future/resource/42",
        },
      ],
      scene_revision: 42,
    };

    const checklist = toChecklist(readiness);
    expect(checklist.at(-1)).toMatchObject({
      id: "future-authoring-check",
      label: "Future check",
      reason: "A future route needs review.",
      state: "stale",
      target_resource: "future/resource/42",
    });
    expect(readiness.scene_revision).toBe(42);
    expect(readiness.checks.at(-1)?.state).toBe("stale");
  });

  it("routes object-specific readiness checks to the existing Inspector subpanels", () => {
    const targetResource = "model/objects/film-7";
    expect(
      resolveScratchAuthoringAction({
        id: "material",
        label: "Material",
        state: "blocked",
        target_resource: targetResource,
      }),
    ).toMatchObject({
      kind: "selection",
      selection: {
        kind: "object.material",
        nodeId: "model:object:film-7:magnetic-parameters:material",
        objectId: "film-7",
        ref: { type: "scene-object", kind: "object.material" },
      },
    });
    expect(
      resolveScratchAuthoringAction({
        id: "texture",
        label: "Texture",
        state: "blocked",
        target_resource: targetResource,
      }),
    ).toMatchObject({
      kind: "selection",
      selection: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:film-7:magnetic-texture",
        objectId: "film-7",
      },
    });
    expect(
      resolveScratchAuthoringAction({
        id: "interactions",
        label: "Interactions",
        state: "blocked",
        target_resource: targetResource,
      }),
    ).toMatchObject({
      kind: "selection",
      selection: {
        kind: "object.physics",
        nodeId: "model:object:film-7:magnetic-parameters:exchange",
        objectId: "film-7",
      },
    });
  });

  it("sends empty-model object checks to the real add-geometry command", () => {
    for (const id of ["geometry", "material", "texture", "interactions"]) {
      expect(
        resolveScratchAuthoringAction({ id, label: id, state: "blocked" }),
      ).toEqual({ kind: "command", commandId: "geometry.add-box", label: "Add box" });
    }
  });

  it("preserves general material, texture, and interaction Explorer targets when no object is available", () => {
    for (const [id, targetResource] of [
      ["material", "model/materials"],
      ["texture", "model/magnetization-assets"],
      ["interactions", "model/objects/interactions"],
    ]) {
      expect(
        resolveScratchAuthoringAction({
          id,
          label: id,
          state: "blocked",
          target_resource: targetResource,
        }),
      ).toEqual({ kind: "explorer", label: "Open Explorer", targetResource });
    }
  });

  it("routes domain, method, execution, and FEM discretization to existing destinations", () => {
    expect(
      resolveScratchAuthoringAction({ id: "domain", label: "Domain", state: "blocked" }),
    ).toMatchObject({ kind: "selection", selection: { kind: "universe.root", nodeId: "model:universe" } });
    expect(
      resolveScratchAuthoringAction({ id: "method", label: "Method", state: "blocked" }),
    ).toMatchObject({ kind: "selection", selection: { kind: "study.root", nodeId: "model:study" } });
    expect(
      resolveScratchAuthoringAction({ id: "execution", label: "Execution", state: "blocked" }),
    ).toMatchObject({ kind: "selection", selection: { kind: "study.execution", nodeId: "model:study:execution" } });
    expect(
      resolveScratchAuthoringAction({ id: "discretization", label: "Discretization", state: "stale", target_resource: "meshing/builds/current" }),
    ).toEqual({ kind: "command", commandId: "mesh.build-shared-domain", label: "Build FEM mesh" });
  });

  it("keeps unknown checks actionable through Explorer without guessing a command", () => {
    expect(
      resolveScratchAuthoringAction({
        id: "future-check",
        label: "Future check",
        state: "blocked",
        target_resource: "future/resource/42",
      }),
    ).toEqual({
      kind: "explorer",
      label: "Open Explorer",
      targetResource: "future/resource/42",
    });
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
