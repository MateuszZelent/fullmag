import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH } from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { buildRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";

import {
  AUTHORING_MUTATION_DEPENDENTS,
  invalidateAuthoringMutationDependents,
} from "./authoringMutationInvalidation";

describe("authoring mutation readiness invalidation", () => {
  it.each([
    "../../modules/inspector/panels/ObjectMaterialPanel.tsx",
    "../../modules/inspector/panels/ObjectMagneticTexturePanel.tsx",
    "../../modules/inspector/panels/region/ObjectRegionTexturePanel.tsx",
    "./magnetization-texture/commands.ts",
  ])("routes %s through the bounded dependent helper", (relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

    expect(source).toContain("invalidateAuthoringMutationDependents");
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

  it.each(["material", "magnetization"] as const)(
    "recovers Run after a no-realtime %s ACK refetches status and readiness",
    (kind) => {
      const revision = 18;
      const invalidate = vi.fn();
      const registry = new CommandRegistry();
      for (const command of STUDY_RUNTIME_COMMANDS) registry.register(command);

      const contextAt = (statusSceneRevision: number) => ({
        api: {} as never,
        resourceData: buildRuntimeCommandControlResourceData({
          commandQueue: { commands: [] },
          geometryValidation: { diagnostics: [] },
          meshBuildCurrent: null,
          meshManifest: null,
          modelReadinessData: {
            blockers: [],
            capabilities: {} as never,
            checks: [],
            ready_to_export: true,
            ready_to_run: true,
            scene_revision: revision,
          },
          modelReadinessStatus: "ready",
          sessionStatus: { resources: { scene_revision: statusSceneRevision } },
          solverStatus: { runtime_state: "idle" },
          stageExecution: {
            active_stage_index: null,
            revision: revision,
            runtime_state: "idle",
            stages: [],
          },
        }),
        source: "test" as const,
      });

      expect(registry.isEnabled("study.run", contextAt(revision - 1))).toBe(false);
      expect(
        registry.get("study.run")?.disabledReason?.(contextAt(revision - 1)),
      ).toBe("Model readiness is stale for the current scene.");

      invalidateAuthoringMutationDependents({ invalidate }, kind, revision);

      expect(
        invalidate.mock.calls.filter(
          ([resourceKey, invalidationRevision]) =>
            resourceKey === MODEL_READINESS_PATH && invalidationRevision === revision,
        ),
      ).toHaveLength(1);
      expect(
        invalidate.mock.calls.filter(
          ([resourceKey, invalidationRevision]) =>
            resourceKey === SESSION_STATUS_RESOURCE_KEY &&
            invalidationRevision === revision,
        ),
      ).toHaveLength(1);
      expect(registry.isEnabled("study.run", contextAt(revision))).toBe(true);
      expect(registry.get("study.run")?.disabledReason?.(contextAt(revision))).toBeNull();
    },
  );
});
