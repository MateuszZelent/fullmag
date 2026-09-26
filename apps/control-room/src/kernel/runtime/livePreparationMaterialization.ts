import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type {
  LivePreparationMaterializationResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import type { CommandContext, CommandResult } from "../commands/commandTypes";
import {
  assertCurrentSessionScope,
  obsoleteSessionResult,
} from "../commands/commandSessionScope";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

type JsonRecord = Record<string, unknown>;

export type LivePreparationMaterializationOutcome =
  | { kind: "materialized"; resource: LivePreparationMaterializationResource }
  | { kind: "rejected"; result: CommandResult };

export interface LivePreparationMaterializationOptions {
  expectedSceneRevision?: number | null;
  requireCurrentSharedDomainMesh?: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reject(message: string): LivePreparationMaterializationOutcome {
  return { kind: "rejected", result: { message, status: "failed" } };
}

function rejectedSessionResult(
  result: CommandResult,
): LivePreparationMaterializationOutcome {
  return { kind: "rejected", result };
}

function isSha256Fingerprint(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Materialize a receipt only for the current session, scene, and optional mesh revision. */
export async function materializeCurrentLivePreparation(
  context: CommandContext,
  options: LivePreparationMaterializationOptions = {},
): Promise<LivePreparationMaterializationOutcome> {
  const api = context.api;
  if (!api) return reject("Control-room API is unavailable.");

  try {
    assertCurrentSessionScope(context);
    const requestOptions = context.sessionScopeKey
      ? { sessionScopeKey: context.sessionScopeKey }
      : undefined;
    const preparation: SimulationPreparationResource =
      await api.simulation.preparation(requestOptions);
    const obsoleteAfterPreparation = obsoleteSessionResult(context);
    if (obsoleteAfterPreparation) {
      return rejectedSessionResult(obsoleteAfterPreparation);
    }
    if (!preparation.preparation_id || preparation.status !== "ready") {
      return reject(
        `Live preparation is not ready (status: ${preparation.status}).`,
      );
    }

    const scene = await api.model.scene(requestOptions);
    const obsoleteAfterScene = obsoleteSessionResult(context);
    if (obsoleteAfterScene) return rejectedSessionResult(obsoleteAfterScene);
    const sceneRevision = finiteRevision(scene.revision);
    if (sceneRevision === null) {
      return reject("Scene revision is unavailable; refresh the scene and retry.");
    }
    if (
      typeof options.expectedSceneRevision === "number" &&
      options.expectedSceneRevision !== sceneRevision
    ) {
      return reject(
        `Scene changed during preparation: expected revision ${options.expectedSceneRevision}, received ${sceneRevision}. Retry with the current scene.`,
      );
    }

    if (options.requireCurrentSharedDomainMesh) {
      const manifest = await api.meshing.sharedDomainManifest(requestOptions);
      const obsoleteAfterManifest = obsoleteSessionResult(context);
      if (obsoleteAfterManifest) {
        return rejectedSessionResult(obsoleteAfterManifest);
      }
      if (finiteRevision(manifest?.source_scene_revision) !== sceneRevision) {
        return reject(
          "A shared-domain mesh for the current scene revision is required before preparation.",
        );
      }
    }

    const resource = await api.simulation.materializePreparation(
      {
        preparation_id: preparation.preparation_id,
        scene_revision: sceneRevision,
      },
      requestOptions,
    );
    const obsoleteAfterMaterialization = obsoleteSessionResult(context);
    if (obsoleteAfterMaterialization) {
      return rejectedSessionResult(obsoleteAfterMaterialization);
    }
    if (
      resource.preparation_id !== preparation.preparation_id ||
      resource.scene_revision !== sceneRevision ||
      !isSha256Fingerprint(resource.plan_fingerprint) ||
      !isSha256Fingerprint(resource.receipt_sha256)
    ) {
      return reject(
        "Live preparation returned receipt provenance that does not match the current request.",
      );
    }

    context.resources?.invalidate(
      SIMULATION_PREPARATION_PATH,
      resource.receipt_sha256,
    );
    return { kind: "materialized", resource };
  } catch (error) {
    const obsolete = obsoleteSessionResult(context);
    if (obsolete) return rejectedSessionResult(obsolete);
    return reject(
      error instanceof Error
        ? error.message
        : "Live preparation materialization failed.",
    );
  }
}

export function requiresSharedDomainMeshForLivePreparation(
  context: CommandContext,
): boolean {
  const status = asRecord(context.resourceData?.[SESSION_STATUS_RESOURCE_KEY]);
  const capabilities = asRecord(status?.capabilities);
  const domain = asRecord(status?.domain);
  return (
    capabilities?.explicit_topology === true ||
    (typeof domain?.discretization === "string" &&
      domain.discretization.toLowerCase() === "fem")
  );
}
