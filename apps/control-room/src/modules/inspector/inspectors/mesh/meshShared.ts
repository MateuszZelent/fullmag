import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import {
  resolveSessionAuthoringDiscretization,
  resolveSessionDiscretization,
} from "@/kernel/resources/sessionDiscretization";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import { resolveMeshEditorCapabilities } from "@/shared/domain/mesh/meshEditorCapabilityModel";

import type { UnitOption } from "@/modules/inspector/shared";

const MU0 = 4 * Math.PI * 1e-7;

function safeModField<M extends object, K extends keyof M>(
  mod: M,
  key: K,
): M[K] | undefined {
  return key in mod ? mod[key] : undefined;
}

export const SESSION_STATUS_KEY =
  safeModField(sessionStatusHooks, "SESSION_STATUS_RESOURCE_KEY") ??
  "/session/status";

export const useSafeMeshCapabilitiesResource =
  safeModField(geometryLifecycleResources, "useMeshCapabilitiesResource") ??
  (() =>
    emptyResource<Parameters<typeof resolveMeshEditorCapabilities>[0]>());

export const useSafeMeshBuildLatestSuccessful =
  safeModField(geometryLifecycleResources, "useMeshBuildLatestSuccessful") ??
  (() => emptyResource<{ last_build_error?: unknown; last_success?: unknown }>());

export const useSafeMeshSharedDomainQualityResource =
  safeModField(
    geometryLifecycleResources,
    "useMeshSharedDomainQualityResource",
  ) ?? (() => emptyResource<{ quality?: unknown }>());

export const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export type JsonRecord = Record<string, unknown>;

export function emptyResource<T>() {
  return {
    data: null as T | null,
    error: null,
    refetch: () => Promise.resolve(null),
    revision: 0,
    status: "ready" as const,
  };
}

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function formatLengthSmart(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  const abs = Math.abs(meters);
  if (abs === 0) return "0 nm";
  if (abs < 1e-6) return `${Number((meters * 1e9).toFixed(2))} nm`;
  if (abs < 1e-3) return `${Number((meters * 1e6).toFixed(2))} µm`;
  if (abs < 1) return `${Number((meters * 1e3).toFixed(3))} mm`;
  return `${Number(meters.toFixed(4))} m`;
}

export interface ExchangeLengthGuardEvaluation {
  exchangeLengthM: number;
  materialId: string;
  materialName: string;
  maxActiveCellM: number;
  ratio: number;
  recommendedCellM: number;
  exceeds: boolean;
}

function roundFriendlySubNanometerM(targetM: number): number {
  const nm = targetM * 1e9;
  const candidates = [0.5, 1.0, 1.25, 2.0, 2.5, 3.125, 4.0, 5.0, 6.25, 8.0, 10.0];
  let best = Math.max(0.5, Math.floor(nm * 10) / 10);
  for (const candidate of candidates) {
    if (candidate <= nm) {
      best = candidate;
    }
  }
  return best * 1e-9;
}

/**
 * Estimates the structured FDM grid dimensions [nx, ny, nz] from the authored
 * scene bounding box and requested cell spacing. Returns null if no parametric
 * object extents are present in the scene.
 */
export function estimateSceneFdmGridShape(
  scene: unknown,
  cellSizeM: readonly [number, number, number],
  fftSmoothSnap: boolean,
): [number, number, number] | null {
  const sceneRec = asRecord(scene);
  const rawObjects = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const rawObj of rawObjects) {
    const obj = asRecord(rawObj);
    if (!obj || obj.visible === false) continue;
    const geom = asRecord(obj.geometry);
    const params = asRecord(geom?.geometry_params);
    const kind = asString(geom?.geometry_kind)?.toLowerCase() ?? "";
    const transform = asRecord(obj.transform);
    const translation = Array.isArray(transform?.translation)
      ? transform.translation.map(asNumber)
      : [0, 0, 0];
    const scale = Array.isArray(transform?.scale)
      ? transform.scale.map((v) => Math.abs(asNumber(v) ?? 1))
      : [1, 1, 1];
    const tx = translation[0] ?? 0;
    const ty = translation[1] ?? 0;
    const tz = translation[2] ?? 0;

    let sx: number | null = null;
    let sy: number | null = null;
    let sz: number | null = null;
    if (kind === "box" && Array.isArray(params?.size) && params.size.length >= 3) {
      sx = asNumber(params.size[0]);
      sy = asNumber(params.size[1]);
      sz = asNumber(params.size[2]);
    } else if (kind === "cylinder") {
      const r = asNumber(params?.radius);
      const h = asNumber(params?.height);
      if (r !== null && h !== null) {
        sx = r * 2;
        sy = r * 2;
        sz = h;
      }
    } else if (kind === "sphere") {
      const r = asNumber(params?.radius);
      if (r !== null) {
        sx = r * 2;
        sy = r * 2;
        sz = r * 2;
      }
    }
    if (sx === null || sy === null || sz === null || sx <= 0 || sy <= 0 || sz <= 0) {
      continue;
    }
    const hx = (sx * (scale[0] || 1)) / 2;
    const hy = (sy * (scale[1] || 1)) / 2;
    const hz = (sz * (scale[2] || 1)) / 2;
    minX = Math.min(minX, tx - hx);
    maxX = Math.max(maxX, tx + hx);
    minY = Math.min(minY, ty - hy);
    maxY = Math.max(maxY, ty + hy);
    minZ = Math.min(minZ, tz - hz);
    maxZ = Math.max(maxZ, tz + hz);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  const ex = Math.max(1e-12, maxX - minX);
  const ey = Math.max(1e-12, maxY - minY);
  const ez = Math.max(1e-12, maxZ - minZ);
  const dx = Math.max(1e-12, cellSizeM[0]);
  const dy = Math.max(1e-12, cellSizeM[1]);
  const dz = Math.max(1e-12, cellSizeM[2]);
  const rawNx = Math.max(1, Math.ceil(ex / dx - 1e-9));
  const rawNy = Math.max(1, Math.ceil(ey / dy - 1e-9));
  const rawNz = Math.max(1, Math.ceil(ez / dz - 1e-9));
  return [
    fftSmoothSnap ? snapSevenSmooth(rawNx) : rawNx,
    fftSmoothSnap ? snapSevenSmooth(rawNy) : rawNy,
    rawNz,
  ];
}

/**
 * Evaluates the magnetostatic exchange length l_ex = sqrt(2 A_ex / (mu_0 M_s^2))
 * across all materials referenced in the scene and checks max(Delta) against l_ex.
 */
export function computeExchangeLengthGuard(
  scene: unknown,
  spacingM: readonly [number, number, number],
  shape: readonly [number, number, number],
): ExchangeLengthGuardEvaluation | null {
  const sceneRec = asRecord(scene);
  const rawMaterials = Array.isArray(sceneRec?.materials) ? sceneRec.materials : [];
  const rawObjects = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
  const usedMaterialIds = new Set<string>();
  for (const rawObj of rawObjects) {
    const obj = asRecord(rawObj);
    const ref = asString(obj?.material_ref);
    if (ref && ref.toLowerCase() !== "unassigned") {
      usedMaterialIds.add(ref);
    }
  }

  let limiting: { id: string; name: string; lexM: number } | null = null;
  for (const entry of rawMaterials) {
    const mat = asRecord(entry);
    if (!mat) continue;
    const id = asString(mat.id) ?? "material";
    if (usedMaterialIds.size > 0 && !usedMaterialIds.has(id)) continue;
    const name = asString(mat.name) ?? id;
    const props = asRecord(mat.properties) ?? mat;
    const ms =
      asNumber(props.ms) ??
      asNumber(props.Ms) ??
      asNumber(props.saturation_magnetization);
    const aex =
      asNumber(props.aex) ??
      asNumber(props.Aex) ??
      asNumber(props.exchange_stiffness);
    if (ms === null || aex === null || ms <= 0 || aex <= 0) continue;
    const lexM = Math.sqrt((2 * aex) / (MU0 * ms * ms));
    if (!Number.isFinite(lexM) || lexM <= 0) continue;
    if (!limiting || lexM < limiting.lexM) {
      limiting = { id, name, lexM };
    }
  }

  if (!limiting) return null;
  const activeSpacings = [
    spacingM[0],
    spacingM[1],
    shape[2] > 1 ? spacingM[2] : 0,
  ].filter((val) => Number.isFinite(val) && val > 0);
  if (activeSpacings.length === 0) return null;

  const maxActiveCellM = Math.max(...activeSpacings);
  const ratio = maxActiveCellM / limiting.lexM;
  const recommendedCellM = roundFriendlySubNanometerM(0.8 * limiting.lexM);

  return {
    exchangeLengthM: limiting.lexM,
    exceeds: maxActiveCellM > limiting.lexM,
    materialId: limiting.id,
    materialName: limiting.name,
    maxActiveCellM,
    ratio,
    recommendedCellM,
  };
}

export function snapSevenSmooth(n: number): number {
  const start = Math.max(1, Math.round(n));
  for (let candidate = start; candidate <= start * 4 + 8; candidate += 1) {
    let rem = candidate;
    for (const p of [2, 3, 5, 7]) {
      while (rem % p === 0) rem /= p;
    }
    if (rem === 1) return candidate;
  }
  return start;
}

export function useActiveLane(): "fdm" | "fem" | "unresolved" {
  const resolved = sessionStatusHooks.useSessionStatusSelector(
    (status) =>
      resolveSessionDiscretization(status.data) ??
      resolveSessionAuthoringDiscretization(status.data),
  );
  return resolved ?? "unresolved";
}

export function buildSafeMutationContext(
  kernel: ReturnType<typeof useKernel>,
  sessionScopeKey: string | undefined,
  sourceDetail: string,
) {
  const hasScopeGetter = typeof kernel.commands?.getSessionScopeKey === "function";
  const base = createCommandContext("inspector", kernel, {
    isCurrentSessionScope: sessionScopeKey
      ? hasScopeGetter
        ? () => kernel.commands.getSessionScopeKey?.() === sessionScopeKey
        : () => true
      : () => true,
    sessionScopeKey: sessionScopeKey ?? null,
    sourceDetail,
  });
  return {
    ...base,
    selection:
      typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
  };
}
