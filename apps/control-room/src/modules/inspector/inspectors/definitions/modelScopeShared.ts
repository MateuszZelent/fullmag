import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { SceneObjectItem as SceneObject } from "../../panels/model-roots/SpecInspectorHost";

export type SceneCoupling = Extract<AuthoringTransactionRequest, { kind: "create_coupling" }>["coupling"];

export type SceneCouplingPatch = Extract<AuthoringTransactionRequest, { kind: "patch_coupling" }>["patch"];

export function buildModelScopeMutationContext(
  kernel: ReturnType<typeof useKernel>,
  sceneData: unknown,
  explicitScopeKey?: string | null,
) {
  const effectiveScopeKey =
    explicitScopeKey ?? kernel.commands?.getSessionScopeKey?.() ?? null;
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();
  const baseCtx = createCommandContext("inspector", kernel, {
    resourceData: sceneData ? { [MODEL_SCENE_PATH]: sceneData } : undefined,
    ...(effectiveScopeKey ? { sessionScopeKey: effectiveScopeKey } : {}),
    isCurrentSessionScope: () => {
      const activeScope = kernel.commands?.getSessionScopeKey?.();
      if (effectiveScopeKey && activeScope && activeScope !== effectiveScopeKey) {
        return false;
      }
      return (
        historyGeneration === undefined ||
        kernel.authoringHistory?.getGeneration?.() === historyGeneration
      );
    },
  });
  return {
    context:
      typeof kernel.selection?.get === "function"
        ? baseCtx
        : { ...baseCtx, selection: undefined },
    reqOptions: effectiveScopeKey ? { sessionScopeKey: effectiveScopeKey } : undefined,
  };
}

export function extractFieldDriveItems(resourceData: unknown): Record<string, unknown>[] {
  if (!resourceData || typeof resourceData !== "object") return [];
  const rec = resourceData as { drives?: unknown[]; items?: unknown[] };
  const arr = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  return arr as Record<string, unknown>[];
}

/* ── Shared Helpers for Model Roots ── */

export function isAirboxSceneObject(obj: SceneObject): boolean {
  const role = obj.role?.trim().toLowerCase() ?? "";
  const id = obj.id.trim().toLowerCase();
  return role === "air" || role === "airbox" || id === "airbox" || id === "__airbox__";
}

function resolveObjectBoundsMeters(
  obj: SceneObject,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const geom = (obj.geometry ?? null) as Record<string, unknown> | null;
  if (!geom) return null;
  const bMin = geom.bounds_min;
  const bMax = geom.bounds_max;
  if (
    Array.isArray(bMin) &&
    Array.isArray(bMax) &&
    bMin.length >= 3 &&
    bMax.length >= 3 &&
    bMin.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    bMax.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return {
      min: [bMin[0] as number, bMin[1] as number, bMin[2] as number],
      max: [bMax[0] as number, bMax[1] as number, bMax[2] as number],
    };
  }
  const params = (geom.geometry_params ?? null) as Record<string, unknown> | null;
  const tx = (obj.transform ?? null) as Record<string, unknown> | null;
  const tr = Array.isArray(tx?.translation) && tx.translation.length >= 3
    ? [
        Number(tx.translation[0]) || 0,
        Number(tx.translation[1]) || 0,
        Number(tx.translation[2]) || 0,
      ]
    : [0, 0, 0];
  let span: [number, number, number] | null = null;
  if (Array.isArray(params?.size) && params.size.length >= 3) {
    span = [
      Math.abs(Number(params.size[0]) || 0),
      Math.abs(Number(params.size[1]) || 0),
      Math.abs(Number(params.size[2]) || 0),
    ];
  } else if (typeof params?.radius === "number") {
    const r = Math.abs(params.radius);
    const h = typeof params?.height === "number" ? Math.abs(params.height) : 2 * r;
    span = [2 * r, 2 * r, h];
  } else if (
    typeof params?.length === "number" &&
    typeof params?.width === "number" &&
    typeof params?.height === "number"
  ) {
    const archH = typeof params?.arch_height === "number" ? Math.abs(params.arch_height) : 0;
    span = [Math.abs(params.length), Math.abs(params.width), Math.abs(params.height) + archH];
  }
  if (!span || span.some((v) => v <= 0)) return null;
  return {
    min: [tr[0]! - span[0] / 2, tr[1]! - span[1] / 2, tr[2]! - span[2] / 2],
    max: [tr[0]! + span[0] / 2, tr[1]! + span[1] / 2, tr[2]! + span[2] / 2],
  };
}

export function computeSceneObjectsAabb(objects: readonly SceneObject[]): {
  min: [number, number, number];
  max: [number, number, number];
  span: [number, number, number];
  center: [number, number, number];
} | null {
  const authored = objects.filter((o) => !isAirboxSceneObject(o));
  if (authored.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const obj of authored) {
    const bounds = resolveObjectBoundsMeters(obj);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.min[0]);
    minY = Math.min(minY, bounds.min[1]);
    minZ = Math.min(minZ, bounds.min[2]);
    maxX = Math.max(maxX, bounds.max[0]);
    maxY = Math.max(maxY, bounds.max[1]);
    maxZ = Math.max(maxZ, bounds.max[2]);
    count += 1;
  }
  if (count === 0) return null;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    span: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

export function isUnscopedFrozenSelector(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return true;
  const rec = selector as Record<string, unknown>;
  if (rec.kind === "in_object" || rec.kind === "in_region") return false;
  if (
    (rec.kind === "and" || rec.kind === "or" || rec.kind === "xor") &&
    Array.isArray(rec.expressions) &&
    rec.expressions.length > 0
  ) {
    return rec.expressions.some((child) => isUnscopedFrozenSelector(child));
  }
  return true;
}
