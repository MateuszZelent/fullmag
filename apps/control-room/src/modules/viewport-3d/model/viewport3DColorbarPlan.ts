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
  quantityId: string;
  range: ScalarRange | null;
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
  quantityId,
  scalarRangePolicy = DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
  scopeId,
  scopeKind,
}: {
  colorMode: string;
  palette: string;
  quantityId: string;
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
  ].join(":");
}

export function buildViewport3DColorbarRenderKey({
  palette,
  quantityId,
  scalarRangePolicy = DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
  scopeId,
  scopeKind,
}: {
  palette: string;
  quantityId: string;
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
  ].join(":");
}

export function planViewport3DColorbars({
  previousPlans,
  rangeStatesByGroupKey,
  targets,
}: {
  previousPlans?: ReadonlyMap<string, Viewport3DColorbarPlan> | null;
  rangeStatesByGroupKey?:
    | ReadonlyMap<string, Viewport3DColorbarRangeState>
    | null;
  targets: readonly Viewport3DTargetRenderPlan[];
}): Viewport3DColorbarPlan[] {
  const groups = new Map<string, {
    colorMode: string;
    palette: string;
    quantityId: string;
    renderKey: string;
    scopeId: string | null;
    scopeKind: Viewport3DFieldScopeKind;
    targetIds: string[];
  }>();

  for (const target of targets) {
    if (target.targetKind === "airbox") continue;
    if (!target.visible || !target.colorbar.viewportVisible) continue;
    const colorMode = target.shader.scalarColorMode;
    if (!colorMode || !viewport3DColorModeHasNumericColorbar(colorMode)) {
      continue;
    }
    const scope = resolveViewport3DColorbarScope(target);
    const groupKey = buildViewport3DColorbarGroupKey({
      colorMode,
      palette: target.shader.palette,
      quantityId: target.quantityId,
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
        quantityId: resolveCanonicalQuantityId(target.quantityId),
        renderKey: buildViewport3DColorbarRenderKey({
          palette: target.shader.palette,
          quantityId: target.quantityId,
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
      quantityId: group.quantityId,
      range: rangeState.range,
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
  fieldModel,
  plans,
}: {
  fdmSurfaceColors?: ScalarColorBuffer | null;
  fieldModel?: Viewport3DColorbarRangeFieldModel | null;
  plans: readonly Viewport3DColorbarPlan[];
}): ReadonlyMap<string, Viewport3DColorbarRangeState> {
  const rangeStates = new Map<string, Viewport3DColorbarRangeState>();
  const targetPassModelAuthoritative =
    Boolean(fieldModel?.targetPasses) &&
    (fieldModel?.targetPasses?.size ?? 0) > 0;
  for (const plan of plans) {
    const candidate =
      plan.scopeKind === "full" && fdmSurfaceColors
        ? fdmSurfaceColors
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
          : resolveViewport3DTargetSurfaceLayerInput({
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
