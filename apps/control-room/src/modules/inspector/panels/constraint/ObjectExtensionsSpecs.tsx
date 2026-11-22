"use client";

import { Copy, FlipHorizontal2, Plus, Shield, Trash2, Waves } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../template";
import { absorbingExpressionError } from "../absorbingExpressionValidation";
import {
  ABSORBING_BOUNDARY_FACES,
  ABSORBING_BOUNDARY_PROFILES,
  absorbingBoundaryDraftFromObject,
  absorbingBoundaryDraftKey,
  buildAbsorbingBoundaryPatch,
  createLayerDraft,
  type AbsorbingBoundaryDraft,
  type LayerDraft,
} from "../ObjectAbsorbingBoundaryPanelModel";
import {
  objectMaterialMutationCoordinator,
  objectMaterialMutationScopeKey,
} from "../ObjectMaterialPanelEditSession";
import { sceneResourceRevision } from "../ObjectMaterialPanelModel";
import {
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  formatLengthAuto,
  LENGTH_UNITS,
  SpecInspectorHost,
  vectorNorm,
} from "../model-roots/SpecInspectorHost";

/* ── Pure Profile Curve Evaluator for <ScientificEChart> ── */

export function evaluateAbsorbingProfileFactor(
  profile: string,
  uNormalized: number,
): number {
  const u = Math.max(0, Math.min(1, uNormalized));
  switch (profile) {
    case "linear":
      return u;
    case "quadratic":
      return u * u;
    case "smootherstep":
      return u * u * u * (u * (u * 6 - 15) + 10);
    case "logarithmic":
      return Math.log1p(u * (Math.E - 1));
    case "tanh":
      return Math.tanh(3 * u) / Math.tanh(3);
    default:
      return u * u * u;
  }
}

export interface SalLayerSpecItem {
  readonly _layerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly targetRegionId: string;
  readonly contourKind:
    | "faces"
    | "plane"
    | "cylinder"
    | "sphere"
    | "region_boundary"
    | "expression";
  readonly faces: readonly string[];
  readonly totalWidth: number;
  readonly rampWidth: number;
  readonly maxDampingDelta: number;
  readonly profile: string;
  readonly customExpression: string;
  readonly frame: "object" | "universe";
  readonly point: readonly [number, number, number];
  readonly orientation: readonly [number, number, number];
  readonly radius: number;
  readonly direction: "outward" | "inward";
  readonly boundaryRegionId: string;
  readonly distanceExpression: string;
}

interface AbsorbingBoundarySpecDraft {
  objectId: string;
  objectName: string;
  exists: boolean;
  salConfigured: boolean;
  legacy: boolean;
  baseAlpha: number;
  activeLayerIndex: number;
  layers: readonly SalLayerSpecItem[];
  // Active layer flattened fields for ergonomic PropertyRow binding
  layerName: string;
  layerEnabled: boolean;
  targetRegionId: string;
  contourKind: SalLayerSpecItem["contourKind"];
  faces: readonly string[];
  totalWidth: number;
  rampWidth: number;
  maxDampingDelta: number;
  profile: string;
  customExpression: string;
  frame: "object" | "universe";
  point: readonly [number, number, number];
  orientation: readonly [number, number, number];
  radius: number;
  direction: "outward" | "inward";
  boundaryRegionId: string;
  distanceExpression: string;
}

function parseFiniteOrFallback(raw: string, fallback: number): number {
  const num = Number(raw);
  return raw.trim().length > 0 && Number.isFinite(num) ? num : fallback;
}

function layerDraftToSpecItem(l: LayerDraft): SalLayerSpecItem {
  return {
    _layerId: l.id,
    name: l.name,
    enabled: l.enabled,
    targetRegionId: l.region,
    contourKind: l.kind,
    faces: l.faces.length > 0 ? l.faces : ["x+", "x-"],
    totalWidth: parseFiniteOrFallback(l.totalWidth, 50e-9),
    rampWidth: parseFiniteOrFallback(l.rampWidth, 40e-9),
    maxDampingDelta: parseFiniteOrFallback(l.maxDamping, 0.5),
    profile: l.profile || "smootherstep",
    customExpression: l.expression,
    frame: l.frame === "universe" ? "universe" : "object",
    point: [
      parseFiniteOrFallback(l.point[0], 0),
      parseFiniteOrFallback(l.point[1], 0),
      parseFiniteOrFallback(l.point[2], 0),
    ],
    orientation: [
      parseFiniteOrFallback(l.orientation[0], 1),
      parseFiniteOrFallback(l.orientation[1], 0),
      parseFiniteOrFallback(l.orientation[2], 0),
    ],
    radius: parseFiniteOrFallback(l.radius, 5e-7),
    direction: l.direction,
    boundaryRegionId: l.boundaryRegion,
    distanceExpression: l.distanceExpression,
  };
}

function specItemToLayerDraft(l: SalLayerSpecItem): LayerDraft {
  return {
    id: l._layerId,
    name: l.name,
    enabled: l.enabled,
    region: l.targetRegionId,
    kind: l.contourKind,
    faces: [...l.faces],
    totalWidth: String(l.totalWidth),
    rampWidth: String(l.rampWidth),
    maxDamping: String(l.maxDampingDelta),
    profile: l.profile,
    frame: l.frame,
    expression: l.customExpression,
    point: [String(l.point[0]), String(l.point[1]), String(l.point[2])],
    orientation: [String(l.orientation[0]), String(l.orientation[1]), String(l.orientation[2])],
    radius: String(l.radius),
    direction: l.direction,
    boundaryRegion: l.boundaryRegionId,
    distanceExpression: l.distanceExpression,
  };
}

function hydrateActiveLayerFields(
  layers: readonly SalLayerSpecItem[],
  idx: number,
): Pick<
  AbsorbingBoundarySpecDraft,
  | "layerName"
  | "layerEnabled"
  | "targetRegionId"
  | "contourKind"
  | "faces"
  | "totalWidth"
  | "rampWidth"
  | "maxDampingDelta"
  | "profile"
  | "customExpression"
  | "frame"
  | "point"
  | "orientation"
  | "radius"
  | "direction"
  | "boundaryRegionId"
  | "distanceExpression"
> {
  const layer = layers[idx] ?? layers[0]!;
  return {
    layerName: layer.name,
    layerEnabled: layer.enabled,
    targetRegionId: layer.targetRegionId,
    contourKind: layer.contourKind,
    faces: layer.faces,
    totalWidth: layer.totalWidth,
    rampWidth: layer.rampWidth,
    maxDampingDelta: layer.maxDampingDelta,
    profile: layer.profile,
    customExpression: layer.customExpression,
    frame: layer.frame,
    point: layer.point,
    orientation: layer.orientation,
    radius: layer.radius,
    direction: layer.direction,
    boundaryRegionId: layer.boundaryRegionId,
    distanceExpression: layer.distanceExpression,
  };
}

function syncActiveLayerIntoList(draft: AbsorbingBoundarySpecDraft): SalLayerSpecItem[] {
  return draft.layers.map((item, idx) =>
    idx === draft.activeLayerIndex
      ? {
          _layerId: item._layerId,
          name: draft.layerName,
          enabled: draft.layerEnabled,
          targetRegionId: draft.targetRegionId,
          contourKind: draft.contourKind,
          faces: draft.faces,
          totalWidth: draft.totalWidth,
          rampWidth: draft.rampWidth,
          maxDampingDelta: draft.maxDampingDelta,
          profile: draft.profile,
          customExpression: draft.customExpression,
          frame: draft.frame,
          point: draft.point,
          orientation: draft.orientation,
          radius: draft.radius,
          direction: draft.direction,
          boundaryRegionId: draft.boundaryRegionId,
          distanceExpression: draft.distanceExpression,
        }
      : item,
  );
}

function toAbsorbingBoundaryModelDraft(
  draft: AbsorbingBoundarySpecDraft,
  baseline: AbsorbingBoundarySpecDraft,
): AbsorbingBoundaryDraft {
  const syncedLayers = syncActiveLayerIntoList(draft);
  const first = syncedLayers[0];
  const baseFirst = baseline.layers[0];
  const promotedToCollection =
    syncedLayers.length !== 1 ||
    !first ||
    !baseFirst ||
    first.name !== baseFirst.name ||
    first.enabled !== baseFirst.enabled ||
    first.targetRegionId !== baseFirst.targetRegionId ||
    first.contourKind !== "faces";
  return {
    enabled: syncedLayers.length > 0,
    legacy: draft.legacy && !promotedToCollection,
    layers: syncedLayers.map(specItemToLayerDraft),
  };
}

function nextUniqueLayerId(existing: readonly SalLayerSpecItem[]): string {
  const used = new Set(existing.map((l) => l._layerId));
  const candidate =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `layer-${existing.length + 1}-${Date.now().toString(36)}`;
  if (!used.has(candidate)) return candidate;
  let seq = existing.length + 1;
  while (used.has(`layer-${seq}`)) seq += 1;
  return `layer-${seq}`;
}

function isConflictError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /409|revision_conflict|scene_revision_conflict|changed in another edit|Refresh the scene/i.test(
    msg,
  );
}

/* ── Absorbing Damping Curve Chart (<ScientificEChart>) ── */

function SalDampingProfileChart({ draft }: { draft: AbsorbingBoundarySpecDraft }) {
  const samples = useMemo(() => {
    const count = 48;
    const totalNm = Math.max(draft.totalWidth * 1e9, 1e-3);
    const rampNm = Math.min(Math.max(draft.rampWidth * 1e9, 1e-3), totalNm);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= count; i++) {
      const dNm = (i / count) * totalNm;
      const u = dNm <= 0 ? 0 : dNm >= rampNm ? 1 : dNm / rampNm;
      const alphaEff =
        draft.baseAlpha +
        draft.maxDampingDelta * evaluateAbsorbingProfileFactor(draft.profile, u);
      xs.push(Number(dNm.toFixed(2)));
      ys.push(Number(alphaEff.toFixed(5)));
    }
    return { xs, ys };
  }, [draft.baseAlpha, draft.maxDampingDelta, draft.profile, draft.rampWidth, draft.totalWidth]);

  const optionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      grid: { left: 44, right: 12, top: 14, bottom: 26 },
      tooltip: { trigger: "axis" as const },
      xAxis: {
        type: "category" as const,
        data: samples.xs,
        name: "d (nm)",
        nameLocation: "middle" as const,
        nameGap: 18,
      },
      yAxis: {
        type: "value" as const,
        name: "\u03b1_eff",
      },
      series: [
        {
          type: "line" as const,
          smooth: true,
          showSymbol: false,
          data: samples.ys,
          lineStyle: { color: palette.series[0], width: 2 },
          areaStyle: { color: palette.fieldBackground },
        },
      ],
    }),
    [samples.xs, samples.ys],
  );

  return (
    <div className="rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
      <div className="mb-1 flex items-center justify-between text-xs text-[var(--fm-text-muted)]">
        <span>
          Effective damping profile &alpha;<sub>eff</sub>(d)
        </span>
        <span className="font-mono">
          {draft.baseAlpha.toFixed(4)} &rarr; {(draft.baseAlpha + draft.maxDampingDelta).toFixed(3)}
        </span>
      </div>
      <ScientificEChart
        ariaLabel="Spatial absorbing layer damping profile alpha_eff versus depth"
        height={136}
        optionBuilder={optionBuilder}
      />
    </div>
  );
}

/* ── ObjectAbsorbingBoundaryInspectorPanel (`object.absorbing-boundary`) ── */

export function ObjectAbsorbingBoundaryInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const effectiveScopeKey =
    scene.sessionScopeKey ?? kernel.commands?.getSessionScopeKey?.() ?? null;

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : (selection.objectId ?? "");

  const mutationScopeKey = objectMaterialMutationScopeKey(effectiveScopeKey, objectId);
  useSyncExternalStore(
    objectMaterialMutationCoordinator.subscribe,
    objectMaterialMutationCoordinator.getVersion,
    objectMaterialMutationCoordinator.getVersion,
  );
  const activeCoordinatorOp = objectMaterialMutationCoordinator.getActive(mutationScopeKey);

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId) ?? null,
    [objectId, scene.data?.objects],
  );

  const baseRevision = sceneResourceRevision(scene.data);
  const [acknowledgedBase, setAcknowledgedBase] = useState<{
    draft: AbsorbingBoundaryDraft;
    objectId: string;
    revision: number;
  } | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const applyInFlightRef = useRef(false);

  const parsedSceneDraft = useMemo(
    () => absorbingBoundaryDraftFromObject(sceneObj),
    [sceneObj],
  );
  const resourceRevision = baseRevision ?? -1;
  const effectiveModelBase =
    acknowledgedBase?.objectId === objectId && resourceRevision < acknowledgedBase.revision
      ? acknowledgedBase.draft
      : parsedSceneDraft;

  const baseAlpha = useMemo(() => {
    const matRef = sceneObj?.material_ref;
    const mat = matRef ? scene.data?.materials?.find((m) => m.id === matRef) : undefined;
    return typeof mat?.properties?.alpha === "number" ? mat.properties.alpha : 0.008;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const authoredRegions = useMemo(
    () =>
      (sceneObj?.regions ?? []).flatMap((reg) => {
        const regId = String(reg.region_id ?? "");
        if (!regId) return [];
        const baseLabel =
          reg.name && reg.name !== regId ? `${reg.name} (${regId})` : regId;
        return [
          {
            id: regId,
            label: `${baseLabel}${reg.enabled === false ? " (disabled)" : ""}`,
          },
        ];
      }),
    [sceneObj?.regions],
  );

  const regionIds = useMemo(() => authoredRegions.map((r) => r.id), [authoredRegions]);

  const baseline = useMemo<AbsorbingBoundarySpecDraft>(() => {
    const layers = effectiveModelBase.layers.map(layerDraftToSpecItem);
    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      exists: Boolean(sceneObj),
      salConfigured: effectiveModelBase.enabled,
      legacy: effectiveModelBase.legacy,
      baseAlpha,
      activeLayerIndex: 0,
      layers,
      ...hydrateActiveLayerFields(layers, 0),
    };
  }, [baseAlpha, effectiveModelBase, objectId, sceneObj]);

  const targetRegionOptions = useMemo(() => {
    const known = new Set(regionIds);
    const missing = new Set<string>();
    for (const l of baseline.layers) {
      if (l.targetRegionId && !known.has(l.targetRegionId)) {
        missing.add(l.targetRegionId);
      }
    }
    return [
      { value: "", label: "Whole object volume" },
      ...[...missing].map((id) => ({ value: id, label: `Missing region (${id})` })),
      ...authoredRegions.map((r) => ({ value: r.id, label: r.label })),
    ];
  }, [authoredRegions, baseline.layers, regionIds]);

  const boundaryRegionOptions = useMemo(() => {
    const known = new Set(regionIds);
    const missing = new Set<string>();
    for (const l of baseline.layers) {
      if (l.boundaryRegionId && !known.has(l.boundaryRegionId)) {
        missing.add(l.boundaryRegionId);
      }
    }
    return [
      ...[...missing].map((id) => ({ value: id, label: `Missing region (${id})` })),
      ...authoredRegions.map((r) => ({ value: r.id, label: r.label })),
    ];
  }, [authoredRegions, baseline.layers, regionIds]);

  const baselineRef = useRef(baseline);
  useEffect(() => {
    baselineRef.current = baseline;
  }, [baseline]);

  const buildHistoryContext = useCallback(() => {
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const baseCtx = createCommandContext("inspector", kernel, {
      resourceData: { [MODEL_SCENE_PATH]: scene.data },
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
    return typeof kernel.selection?.get === "function"
      ? baseCtx
      : { ...baseCtx, selection: undefined };
  }, [effectiveScopeKey, kernel, scene.data]);

  const spec = useMemo<InspectorSpec<AbsorbingBoundarySpecDraft>>(
    () => ({
      id: "object.absorbing-boundary",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          { id: "sal", label: "Absorbing Boundary" },
        ],
        canFitView: baseline.exists,
        searchable: true,
        ...(baseline.exists && baseline.salConfigured
          ? {
              deleteAction: {
                label: "Remove Absorbing Boundary",
                confirmTitle: () => "Remove spatial absorbing boundary?",
                confirmDescription:
                  "This disables and removes all absorbing damping layers from this object.",
                onDelete: async (ctx) => {
                  const historyContext = buildHistoryContext();
                  const updated = await runAuthoringMutationWithHistory(
                    historyContext,
                    `Remove absorbing boundary ${objectId}`,
                    async ({ baseRevision: capturedRev }) => {
                      const commitRev = capturedRev ?? baseRevision ?? null;
                      return kernel.api.model.patchObject(
                        objectId,
                        {
                          base_revision: commitRev,
                          absorbing_boundary: null,
                        },
                        authoringWriteOptions(commitRev, effectiveScopeKey),
                      );
                    },
                  );
                  const rev = fallbackRevision(updated.revision ?? baseRevision);
                  publishCommittedSceneResource(kernel.resources, updated, rev);
                  if (typeof rev === "number") {
                    invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
                  } else {
                    kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
                  }
                  ctx.selectNode(
                    buildObjectSelection(objectId, "object.root", baseline.objectName),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Waves,
        title: () => "Absorbing Boundary (SAL)",
        kindLabel: "Spatial spin-wave absorbing layer",
        entityId: objectId ? `${objectId}:sal` : undefined,
        statePill: (d) => ({
          tone: d.layerEnabled ? "ok" : "degraded",
          label: `${d.layers.length} layer${d.layers.length === 1 ? "" : "s"}`,
        }),
      },
      facts: (d): readonly InspectorFact[] => {
        const plateauM = d.totalWidth - d.rampWidth;
        return [
          { id: "width", label: "Total width", value: formatLengthAuto(d.totalWidth) },
          { id: "ramp", label: "Ramp width", value: formatLengthAuto(d.rampWidth) },
          {
            id: "plateau",
            label: "Plateau",
            value: plateauM >= 0 ? formatLengthAuto(plateauM) : null,
          },
          {
            id: "peak",
            label: "Peak \u03b1",
            value: (d.baseAlpha + d.maxDampingDelta).toFixed(3),
          },
        ];
      },
      notices: (d): readonly InspectorNotice<AbsorbingBoundarySpecDraft>[] => {
        const list: InspectorNotice<AbsorbingBoundarySpecDraft>[] = [];
        if (conflictNotice) {
          list.push({
            id: "sal-conflict",
            tone: "err",
            title: "Concurrent revision conflict",
            text: conflictNotice,
            quickFix: {
              label: "Reload latest scene",
              onApply: async (ctx) => {
                setConflictNotice(null);
                setAcknowledgedBase(null);
                await scene.refetch?.();
                ctx.patchDraft(baselineRef.current);
              },
            },
          });
        }

        const modelDraft = toAbsorbingBoundaryModelDraft(d, baseline);
        const validation = buildAbsorbingBoundaryPatch(modelDraft, baseRevision, regionIds);
        const activeLayer = d.layers[d.activeLayerIndex] ?? d.layers[0];
        if (
          "error" in validation &&
          validation.layerId &&
          validation.layerId !== activeLayer?._layerId
        ) {
          const offendingIdx = d.layers.findIndex((l) => l._layerId === validation.layerId);
          const offendingName =
            (offendingIdx >= 0 ? d.layers[offendingIdx]?.name : null) || "Inactive layer";
          list.push({
            id: `sal-inactive-layer-${validation.layerId}`,
            tone: "err",
            title: `${offendingName} validation error`,
            text: `${offendingName} \u2014 ${validation.error}`,
            ...(offendingIdx >= 0
              ? {
                  quickFix: {
                    label: `Inspect ${offendingName}`,
                    onApply: (ctx) => {
                      const synced = syncActiveLayerIntoList(ctx.draft);
                      ctx.patchDraft({
                        layers: synced,
                        activeLayerIndex: offendingIdx,
                        ...hydrateActiveLayerFields(synced, offendingIdx),
                      });
                    },
                  },
                }
              : {}),
          });
        }
        return list;
      },
      sections: [
        {
          id: "sal-layers-bar",
          title: "Absorbing layer stack & target",
          icon: Shield,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap items-center gap-1.5" data-slot="sal-layer-pills">
                  {ctx.draft.layers.map((layer, idx) => {
                    const isSelected = idx === ctx.draft.activeLayerIndex;
                    const displayName = isSelected ? ctx.draft.layerName : layer.name;
                    const isEnabled = isSelected ? ctx.draft.layerEnabled : layer.enabled;
                    return (
                      <Button
                        key={layer._layerId}
                        size="sm"
                        type="button"
                        variant={isSelected ? "primary" : "secondary"}
                        onClick={() => {
                          const synced = syncActiveLayerIntoList(ctx.draft);
                          ctx.patchDraft({
                            layers: synced,
                            activeLayerIndex: idx,
                            ...hydrateActiveLayerFields(synced, idx),
                          });
                        }}
                      >
                        {displayName || "Unnamed layer"}
                        {isEnabled ? "" : " (disabled)"}
                      </Button>
                    );
                  })}
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      const synced = syncActiveLayerIntoList(ctx.draft);
                      const nextIdx = synced.length;
                      const newId = nextUniqueLayerId(synced);
                      const defaultLayer = createLayerDraft(newId, `Layer ${nextIdx + 1}`);
                      const created = layerDraftToSpecItem(defaultLayer);
                      const nextLayers = [...synced, created];
                      ctx.patchDraft({
                        legacy: false,
                        layers: nextLayers,
                        activeLayerIndex: nextIdx,
                        ...hydrateActiveLayerFields(nextLayers, nextIdx),
                      });
                    }}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add layer</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      const synced = syncActiveLayerIntoList(ctx.draft);
                      const active = synced[ctx.draft.activeLayerIndex] ?? synced[0];
                      if (!active) return;
                      const nextIdx = synced.length;
                      const copyId = nextUniqueLayerId(synced);
                      const duplicated: SalLayerSpecItem = {
                        ...active,
                        _layerId: copyId,
                        faces: [...active.faces],
                        point: [...active.point],
                        orientation: [...active.orientation],
                        name: `${active.name || "Layer"} copy`,
                      };
                      const nextLayers = [...synced, duplicated];
                      ctx.patchDraft({
                        legacy: false,
                        layers: nextLayers,
                        activeLayerIndex: nextIdx,
                        ...hydrateActiveLayerFields(nextLayers, nextIdx),
                      });
                    }}
                  >
                    <Copy aria-hidden="true" size={12} />
                    <span>Duplicate layer</span>
                  </Button>
                  {ctx.draft.layers.length > 1 ? (
                    <Button
                      aria-label="Remove active layer"
                      size="icon"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        const synced = syncActiveLayerIntoList(ctx.draft);
                        const filtered = synced.filter(
                          (_, idx) => idx !== ctx.draft.activeLayerIndex,
                        );
                        const nextIdx = Math.max(0, ctx.draft.activeLayerIndex - 1);
                        ctx.patchDraft({
                          legacy: false,
                          layers: filtered,
                          activeLayerIndex: nextIdx,
                          ...hydrateActiveLayerFields(filtered, nextIdx),
                        });
                      }}
                    >
                      <Trash2 aria-hidden="true" size={12} />
                    </Button>
                  ) : null}
                </div>
              ),
            },
            {
              key: "layerName",
              type: "text",
              label: "Layer name",
              validate: (v) => (v.trim().length === 0 ? "Enter a layer name." : null),
            },
            {
              key: "layerEnabled",
              type: "switch",
              label: "Enable absorbing layer",
            },
            {
              key: "targetRegionId",
              type: "select",
              label: "Target region",
              options: targetRegionOptions,
              validate: (v) =>
                v && !regionIds.includes(v)
                  ? "Choose an existing target region or the whole object."
                  : null,
            },
          ],
        },
        {
          id: "sal-contour-geometry",
          title: "Contour geometry & widths",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              key: "contourKind",
              type: "select",
              label: "Contour geometry",
              structural: true,
              options: [
                { value: "faces", label: "Bounding-box faces (x\u00b1, y\u00b1, z\u00b1)" },
                { value: "plane", label: "Arbitrary cut plane" },
                { value: "cylinder", label: "Cylindrical radial shell" },
                { value: "sphere", label: "Spherical radial shell" },
                { value: "region_boundary", label: "Authored region boundary" },
                { value: "expression", label: "Custom signed-distance expression" },
              ],
            },
            {
              key: "frame",
              type: "segmented",
              label: "Coordinate frame",
              showWhen: (d) => d.contourKind !== "region_boundary",
              options: [
                { value: "object", label: "Object local" },
                { value: "universe", label: "Universe world" },
              ],
            },
            {
              key: "faces",
              type: "toggles",
              label: "Absorbing boundary faces",
              showWhen: (d) => d.contourKind === "faces",
              options: ABSORBING_BOUNDARY_FACES.map((f) => ({
                value: f,
                label: f.toUpperCase(),
              })),
              validate: (faces) =>
                faces.length === 0 ? "Select at least one boundary face." : null,
            },
            {
              key: "point",
              type: "vector3",
              label: "Reference origin / center",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) =>
                d.contourKind === "plane" ||
                d.contourKind === "cylinder" ||
                d.contourKind === "sphere",
            },
            {
              key: "orientation",
              type: "vector3",
              label: "Normal / cylinder axis",
              axisPresets: true,
              normalizeAction: true,
              hint: "For planes, damping increases along the normal toward the cut plane.",
              showWhen: (d) => d.contourKind === "plane" || d.contourKind === "cylinder",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Enter a finite nonzero direction vector." : null,
            },
            {
              type: "custom",
              showWhen: (d) => d.contourKind === "plane",
              render: (ctx) => (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[var(--fm-text-muted)]">
                    Damping increases along the normal toward the plane.
                  </span>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const [ox, oy, oz] = ctx.draft.orientation;
                      ctx.setField("orientation", [-ox || 0, -oy || 0, -oz || 0]);
                    }}
                  >
                    <FlipHorizontal2 aria-hidden="true" size={12} />
                    <span>Reverse normal</span>
                  </Button>
                </div>
              ),
            },
            {
              key: "radius",
              type: "quantity",
              label: "Shell onset radius",
              symbol: <>R</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.contourKind === "cylinder" || d.contourKind === "sphere",
              validate: (v, d) => {
                if (!Number.isFinite(v) || v <= 0) {
                  return "Radius must be finite and positive.";
                }
                if (d.direction === "outward" && v < d.totalWidth) {
                  return "An outward-rising layer needs a radius at least as large as its total width.";
                }
                return null;
              },
            },
            {
              key: "direction",
              type: "segmented",
              label: "Damping growth direction",
              showWhen: (d) => d.contourKind === "cylinder" || d.contourKind === "sphere",
              options: [
                { value: "outward", label: "Outward" },
                { value: "inward", label: "Inward" },
              ],
            },
            {
              key: "boundaryRegionId",
              type: "select",
              label: "Boundary reference region",
              showWhen: (d) => d.contourKind === "region_boundary",
              options: boundaryRegionOptions,
              hint:
                authoredRegions.length > 0
                  ? "Measures inward distance in the selected region's coordinate frame."
                  : "Create a region under this object's Regions node to anchor by boundary.",
              validate: (v) =>
                !v || !regionIds.includes(v)
                  ? "Choose an existing region whose boundary the layer follows."
                  : null,
            },
            {
              key: "distanceExpression",
              type: "expression",
              label: "Signed distance expression d(x, y, z)",
              placeholder: "5e-7 - sqrt(x**2 + y**2)",
              allowedVariables: ["x", "y", "z"],
              hint: "Coordinates and distance are in metres; layer occupies 0 \u2264 d \u2264 total width.",
              showWhen: (d) => d.contourKind === "expression",
              validate: (v) => absorbingExpressionError(v, "distance") ?? null,
            },
            {
              key: "totalWidth",
              type: "quantity",
              label: "Total absorbing width",
              symbol: (
                <>
                  w<sub>tot</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              validate: (v) =>
                Number.isFinite(v) && v > 0 ? null : "Total width must be a finite positive number.",
            },
            {
              key: "rampWidth",
              type: "quantity",
              label: "Ramp rise width",
              symbol: (
                <>
                  w<sub>ramp</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              validate: (v, d) =>
                !Number.isFinite(v) || v <= 0 || v > d.totalWidth
                  ? "Ramp width must be positive and no greater than total width."
                  : null,
            },
          ],
        },
        {
          id: "sal-damping-profile",
          title: "Damping ramp profile & preview",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              key: "maxDampingDelta",
              type: "number",
              label: "Maximum damping increment",
              symbol: (
                <>
                  &Delta;&alpha;<sub>max</sub>
                </>
              ),
              hint: "Added to local material damping; set 0 for a diagnostic zero-damping layer.",
              min: 0,
              step: 0.05,
              validate: (v) =>
                Number.isFinite(v) && v >= 0
                  ? null
                  : "Maximum damping must be finite and non-negative.",
            },
            {
              key: "profile",
              type: "select",
              label: "Ramp profile shape",
              structural: true,
              options: ABSORBING_BOUNDARY_PROFILES.map((p) => ({
                value: p,
                label: p.charAt(0).toUpperCase() + p.slice(1),
              })),
            },
            {
              key: "customExpression",
              type: "expression",
              label: "Custom profile f(u) on u \u2208 [0, 1]",
              placeholder: "u**3",
              allowedVariables: ["u"],
              hint: "Must stay within [0, 1] with f(0) = 0 and f(1) = 1.",
              showWhen: (d) => d.profile === "custom",
              validate: (v) => absorbingExpressionError(v, "profile") ?? null,
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => <SalDampingProfileChart draft={ctx.draft} />,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (_, base) => !base.salConfigured,
        applyLabel: (_, dirty) =>
          !baseline.salConfigured && !dirty ? "Enable Absorbing Boundary" : "Apply",
        cleanMessage: (d) =>
          d.salConfigured
            ? "Absorbing boundary configuration matches SceneDocument"
            : "Ready to enable default spatial absorbing boundary",
        lockReason: (d) => {
          if (!d.exists) return "Select an existing scene object.";
          if (activeCoordinatorOp) {
            return `${activeCoordinatorOp.operation} is still saving. Wait for its acknowledgement before starting another update.`;
          }
          if (conflictNotice) return conflictNotice;
          const modelDraft = toAbsorbingBoundaryModelDraft(d, baseline);
          const validation = buildAbsorbingBoundaryPatch(modelDraft, baseRevision, regionIds);
          const activeLayer = d.layers[d.activeLayerIndex] ?? d.layers[0];
          if (
            "error" in validation &&
            validation.layerId &&
            validation.layerId !== activeLayer?._layerId
          ) {
            const offendingName =
              d.layers.find((l) => l._layerId === validation.layerId)?.name || "Layer";
            return `${offendingName} \u2014 ${validation.error}`;
          }
          return null;
        },
        onRevert: () => {
          setConflictNotice(null);
        },
        onApply: async (draft, currentBaseline) => {
          if (applyInFlightRef.current) return false;
          const modelDraft = toAbsorbingBoundaryModelDraft(draft, currentBaseline);
          const precheck = buildAbsorbingBoundaryPatch(modelDraft, baseRevision, regionIds);
          if ("error" in precheck) {
            throw new Error(precheck.error);
          }

          const historyContext = buildHistoryContext();
          const lease = objectMaterialMutationCoordinator.acquire(
            mutationScopeKey,
            "Absorbing boundary",
          );
          if (!lease) {
            throw new Error(
              "Another material or absorbing-boundary update is still saving. Wait for its acknowledgement.",
            );
          }

          applyInFlightRef.current = true;
          try {
            const response = await runAuthoringMutationWithHistory(
              historyContext,
              `Update absorbing boundary ${objectId}`,
              async ({ before, baseRevision: capturedRev }) => {
                const commitRevision = capturedRev ?? baseRevision ?? null;
                let commitRegionIds = regionIds;
                if (
                  before &&
                  typeof capturedRev === "number" &&
                  typeof baseRevision === "number" &&
                  capturedRev !== baseRevision
                ) {
                  const currentObj = before.objects?.find((c) => c.id === objectId);
                  const currentKey = absorbingBoundaryDraftKey(
                    absorbingBoundaryDraftFromObject(currentObj),
                  );
                  if (!currentObj || currentKey !== absorbingBoundaryDraftKey(effectiveModelBase)) {
                    throw new Error(
                      "The absorbing boundary changed in another edit. Reload the latest scene before applying.",
                    );
                  }
                  commitRegionIds = (currentObj.regions ?? []).flatMap((r) =>
                    r.region_id ? [r.region_id] : [],
                  );
                }
                const built = buildAbsorbingBoundaryPatch(
                  modelDraft,
                  commitRevision,
                  commitRegionIds,
                );
                if ("error" in built) {
                  throw new Error(built.error);
                }
                return kernel.api.model.patchObject(
                  objectId,
                  built.patch,
                  authoringWriteOptions(commitRevision, effectiveScopeKey),
                );
              },
            );

            if (historyContext.isCurrentSessionScope?.() === false) {
              return false;
            }

            setConflictNotice(null);
            const revNum =
              typeof response.revision === "number"
                ? response.revision
                : typeof baseRevision === "number"
                  ? baseRevision + 1
                  : null;
            const savedObject = response.objects?.find((c) => c.id === objectId);
            const acknowledged = absorbingBoundaryDraftFromObject(savedObject ?? precheck.patch);
            if (revNum !== null) {
              setAcknowledgedBase({ objectId, revision: revNum, draft: acknowledged });
            }
            const rev = fallbackRevision(response.revision ?? revNum);
            publishCommittedSceneResource(kernel.resources, response, rev);
            if (typeof rev === "number") {
              invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
            } else {
              kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
            }
            return true;
          } catch (error) {
            if (isConflictError(error)) {
              const message =
                error instanceof Error
                  ? error.message
                  : "The absorbing boundary changed in another edit. Reload the latest scene before applying.";
              setConflictNotice(message);
              void scene.refetch?.();
            }
            throw error;
          } finally {
            applyInFlightRef.current = false;
            objectMaterialMutationCoordinator.finish(lease);
          }
        },
      },
    }),
    [
      activeCoordinatorOp,
      authoredRegions.length,
      baseRevision,
      baseline,
      boundaryRegionOptions,
      buildHistoryContext,
      conflictNotice,
      effectiveModelBase,
      effectiveScopeKey,
      kernel,
      mutationScopeKey,
      objectId,
      regionIds,
      scene,
      targetRegionOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
