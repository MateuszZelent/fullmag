import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";

import type { ScalarColorBuffer, ScalarRange } from "../viewport3dFieldMapping";
import {
  DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
  type Viewport3DScalarRangePolicy,
  Viewport3DFieldScopeKind,
  Viewport3DTargetRenderPlan,
} from "./viewport3DFieldDataPlan";
import { resolveViewport3DTargetSurfaceLayerInput } from "../layers/viewport3DLayerPassInputs";

export type Viewport3DColorbarRangeStateKind =
  | "current"
  | "pending"
  | "stale-compatible"
  | "unavailable";

export interface Viewport3DColorbarRangeState {
  range: ScalarRange | null;
  state: Viewport3DColorbarRangeStateKind;
}

export interface Viewport3DColorbarPlan {
  colorMode: string;
  groupKey: string;
  legendId: string;
  palette: string;
  projectionMode: Viewport3DTargetRenderPlan["shader"]["projectionMode"];
  quantityId: string;
  range: ScalarRange | null;
  rangeSource: NonNullable<ScalarColorBuffer["rangeSource"]>;
  rangeState: Viewport3DColorbarRangeStateKind;
  renderKey: string;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
  targetIds: readonly string[];
}

export interface Viewport3DColorbarRangeFieldModel {
  scalarColorsByMode: ReadonlyMap<string, ScalarColorBuffer | null>;
  scalarColorsByPartAndMode: ReadonlyMap<
    string,
    ReadonlyMap<string, ScalarColorBuffer | null>
  >;
  targetPasses?: ReadonlyMap<
    string,
    {
      surface: {
        scalarColorMode: string | null;
        scalarColors: ScalarColorBuffer | null;
      };
    }
  >;
}

export function buildViewport3DColorbarGroupKey({
  colorMode,
  palette,
  projectionMode,
  quantityId,
  rangeSource,
  scalarRangePolicy = DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
  scopeId,
  scopeKind,
}: {
  colorMode: string;
  palette: string;
  projectionMode?: Viewport3DTargetRenderPlan["shader"]["projectionMode"];
  quantityId: string;
  rangeSource?: NonNullable<ScalarColorBuffer["rangeSource"]>;
  scalarRangePolicy?: Viewport3DScalarRangePolicy;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
}): string {
  return [
    resolveCanonicalQuantityId(quantityId),
    colorMode,
    palette,
    scopeKind,
    scopeId ?? "none",
    scalarRangePolicyKey(scalarRangePolicy),
    `projection=${projectionMode ?? "raw_nodal"}`,
    `rangeSource=${rangeSource ?? "raw_nodal"}`,
  ].join(":");
}

export function buildViewport3DColorbarRenderKey({
  palette,
  projectionMode,
  quantityId,
  rangeSource,
  scalarRangePolicy = DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
  scopeId,
  scopeKind,
}: {
  palette: string;
  projectionMode?: Viewport3DTargetRenderPlan["shader"]["projectionMode"];
  quantityId: string;
  rangeSource?: NonNullable<ScalarColorBuffer["rangeSource"]>;
  scalarRangePolicy?: Viewport3DScalarRangePolicy;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
}): string {
  return [
    resolveCanonicalQuantityId(quantityId),
    palette,
    scopeKind,
    scopeId ?? "none",
    scalarRangePolicyKey(scalarRangePolicy),
    `projection=${projectionMode ?? "raw_nodal"}`,
    `rangeSource=${rangeSource ?? "raw_nodal"}`,
  ].join(":");
}

export function planViewport3DColorbars({
  includeInspectorRanges = false,
  previousPlans,
  rangeStatesByGroupKey,
  targets,
}: {
  includeInspectorRanges?: boolean;
  previousPlans?: ReadonlyMap<string, Viewport3DColorbarPlan> | null;
  rangeStatesByGroupKey?:
    | ReadonlyMap<string, Viewport3DColorbarRangeState>
    | null;
  targets: readonly Viewport3DTargetRenderPlan[];
}): Viewport3DColorbarPlan[] {
  const groups = new Map<string, {
    colorMode: string;
    palette: string;
    projectionMode: Viewport3DTargetRenderPlan["shader"]["projectionMode"];
    quantityId: string;
    rangeSource: NonNullable<ScalarColorBuffer["rangeSource"]>;
    renderKey: string;
    scopeId: string | null;
    scopeKind: Viewport3DFieldScopeKind;
    targetIds: string[];
  }>();

  for (const target of targets) {
    if (
      !target.visible ||
      (!target.colorbar.viewportVisible &&
        !(includeInspectorRanges && target.colorbar.inspectorVisible))
    ) {
      continue;
    }
    const colorMode = target.colorbar.scalarColorMode;
    if (!colorMode || !viewport3DColorModeHasNumericColorbar(colorMode)) {
      continue;
    }
    const scope = resolveViewport3DColorbarScope(target);
    const rangeSource = viewport3DProjectionDefaultRangeSource({
      projectionMode: target.shader.projectionMode,
      scalarRangePolicy: target.shader.scalarRangePolicy,
    });
    const groupKey = buildViewport3DColorbarGroupKey({
      colorMode,
      palette: target.shader.palette,
      projectionMode: target.shader.projectionMode,
      quantityId: target.quantityId,
      rangeSource,
      scalarRangePolicy: target.shader.scalarRangePolicy,
      scopeId: scope.scopeId,
      scopeKind: scope.scopeKind,
    });
    const group = groups.get(groupKey);
    if (group) {
      group.targetIds.push(target.targetId);
    } else {
      groups.set(groupKey, {
        colorMode,
        palette: target.shader.palette,
        projectionMode: target.shader.projectionMode,
        quantityId: resolveCanonicalQuantityId(target.quantityId),
        rangeSource,
        renderKey: buildViewport3DColorbarRenderKey({
          palette: target.shader.palette,
          projectionMode: target.shader.projectionMode,
          quantityId: target.quantityId,
          rangeSource,
          scalarRangePolicy: target.shader.scalarRangePolicy,
          scopeId: scope.scopeId,
          scopeKind: scope.scopeKind,
        }),
        scopeId: scope.scopeId,
        scopeKind: scope.scopeKind,
        targetIds: [target.targetId],
      });
    }
  }

  return Array.from(groups, ([groupKey, group]) => {
    const rangeState = resolveViewport3DColorbarRangeState({
      groupKey,
      previousPlans,
      rangeStatesByGroupKey,
    });
    const targetIds = group.targetIds.toSorted();
    return {
      colorMode: group.colorMode,
      groupKey,
      legendId: `viewport-3d-colorbar:${groupKey}`,
      palette: group.palette,
      projectionMode: group.projectionMode,
      quantityId: group.quantityId,
      range: rangeState.range,
      rangeSource: group.rangeSource,
      rangeState: rangeState.state,
      renderKey: `viewport-3d-colorbar:${group.renderKey}`,
      scopeId: group.scopeId,
      scopeKind: group.scopeKind,
      targetIds,
    };
  }).toSorted((left, right) => left.groupKey.localeCompare(right.groupKey));
}

export function resolveViewport3DColorbarRangeStates({
  fdmSurfaceColors,
  fdmTargetColorBuffers,
  fdmVectorColors,
  fieldModel,
  plans,
}: {
  fdmSurfaceColors?: ScalarColorBuffer | null;
  fdmTargetColorBuffers?: ReadonlyMap<string, ScalarColorBuffer | null>;
  fdmVectorColors?: ScalarColorBuffer | null;
  fieldModel?: Viewport3DColorbarRangeFieldModel | null;
  plans: readonly Viewport3DColorbarPlan[];
}): ReadonlyMap<string, Viewport3DColorbarRangeState> {
  const rangeStates = new Map<string, Viewport3DColorbarRangeState>();
  const targetPassModelAuthoritative =
    Boolean(fieldModel?.targetPasses) &&
    (fieldModel?.targetPasses?.size ?? 0) > 0;
  for (const plan of plans) {
    const fdmTargetColorBuffer = plan.targetIds
      .map((targetId) => fdmTargetColorBuffers?.get(targetId) ?? null)
      .find((buffer) =>
        scalarColorBufferMatchesColorbarRequest({
          buffer,
          colorMode: plan.colorMode,
          colorPalette: plan.palette,
          quantityId: plan.quantityId,
        }),
      ) ?? null;
    const scopedScalarColors =
      plan.scopeId == null
        ? null
        : fieldModel?.scalarColorsByPartAndMode
            .get(plan.scopeId)
            ?.get(plan.colorMode) ?? null;
    const fdmColorBuffer =
      plan.scopeKind === "full"
        ? [fdmSurfaceColors, fdmVectorColors].find((buffer) =>
            scalarColorBufferMatchesColorbarRequest({
              buffer,
              colorMode: plan.colorMode,
              colorPalette: plan.palette,
              quantityId: plan.quantityId,
            }),
          ) ?? null
        : null;
    const candidate =
      fdmTargetColorBuffer
        ? fdmTargetColorBuffer
        : fdmColorBuffer
        ? fdmColorBuffer
        : plan.scopeKind === "full"
          ? resolveViewport3DTargetSurfaceLayerInput({
              fieldModel: fieldModel ?? null,
              partId: "full",
              scalarColorMode: plan.colorMode,
            }).scalarColors ??
            (targetPassModelAuthoritative
              ? null
              : fieldModel?.scalarColorsByMode.get(plan.colorMode) ?? null)
        : plan.scopeId == null
          ? targetPassModelAuthoritative
            ? null
            : fieldModel?.scalarColorsByMode.get(plan.colorMode) ?? null
          : scopedScalarColors ??
            resolveViewport3DTargetSurfaceLayerInput({
              fieldModel: fieldModel ?? null,
              partId: plan.scopeId,
              scalarColorMode: plan.colorMode,
            }).scalarColors;
    const buffer = scalarColorBufferMatchesColorbarRequest({
      buffer: candidate,
      colorMode: plan.colorMode,
      colorPalette: plan.palette,
      quantityId: plan.quantityId,
    })
      ? candidate
      : null;
    rangeStates.set(plan.groupKey, {
      range: buffer?.range ?? null,
      state: buffer ? "current" : "pending",
    });
  }
  return rangeStates;
}

export function scalarColorBufferMatchesColorbarRequest({
  buffer,
  colorMode,
  colorPalette,
  quantityId,
}: {
  buffer: ScalarColorBuffer | null | undefined;
  colorMode: string;
  colorPalette: string;
  quantityId: string;
}): boolean {
  if (!buffer) return false;
  if (buffer.colorMode && buffer.colorMode !== colorMode) return false;
  if (buffer.colorPalette && buffer.colorPalette !== colorPalette) {
    return false;
  }
  if (
    buffer.quantityId &&
    resolveCanonicalQuantityId(buffer.quantityId) !==
      resolveCanonicalQuantityId(quantityId)
  ) {
    return false;
  }
  return true;
}

function resolveViewport3DColorbarRangeState({
  groupKey,
  previousPlans,
  rangeStatesByGroupKey,
}: {
  groupKey: string;
  previousPlans?: ReadonlyMap<string, Viewport3DColorbarPlan> | null;
  rangeStatesByGroupKey?:
    | ReadonlyMap<string, Viewport3DColorbarRangeState>
    | null;
}): Viewport3DColorbarRangeState {
  const current = rangeStatesByGroupKey?.get(groupKey) ?? null;
  const previous = previousPlans?.get(groupKey) ?? null;
  if (current?.range) return current;
  if (previous?.range) {
    return {
      range: previous.range,
      state: "stale-compatible",
    };
  }
  if (current) return current;
  return {
    range: null,
    state: "unavailable",
  };
}

function scalarRangePolicyKey(policy: Viewport3DScalarRangePolicy): string {
  return [
    "range",
    policy.mode,
    policy.scale,
    policy.symmetric ? "symmetric" : "asymmetric",
    policy.min ?? "min:auto",
    policy.max ?? "max:auto",
  ].join("=");
}

function viewport3DProjectionDefaultRangeSource({
  projectionMode,
  scalarRangePolicy,
}: {
  projectionMode: Viewport3DTargetRenderPlan["shader"]["projectionMode"];
  scalarRangePolicy: Viewport3DScalarRangePolicy;
}): NonNullable<ScalarColorBuffer["rangeSource"]> {
  if (scalarRangePolicy.mode !== "auto") return "manual";
  if (projectionMode === "surface_faces") return "face_values";
  if (projectionMode === "thickness_average_z") return "projected_values";
  return "raw_nodal";
}

function viewport3DColorModeHasNumericColorbar(colorMode: string): boolean {
  return (
    colorMode === "x" ||
    colorMode === "y" ||
    colorMode === "z" ||
    colorMode === "magnitude"
  );
}

function resolveViewport3DColorbarScope(
  target: Viewport3DTargetRenderPlan,
): { scopeId: string | null; scopeKind: Viewport3DFieldScopeKind } {
  if (target.targetKind === "fdm-domain") {
    return {
      scopeId: null,
      scopeKind: "full",
    };
  }
  if (target.targetKind === "airbox") {
    return {
      scopeId: target.targetId,
      scopeKind: "airbox",
    };
  }
  if (target.targetKind === "part" || target.targetKind === "region") {
    return {
      scopeId: target.targetId,
      scopeKind: "part",
    };
  }
  return {
    scopeId: target.targetId,
    scopeKind: "object",
  };
}
