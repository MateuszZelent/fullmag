"use client";

import { Plus, Shield, Trash2, Waves } from "lucide-react";
import { useMemo } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AbsorbingBoundaryConfig } from "@/kernel/api/apiTypes";
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
import type { InspectorFact, InspectorSpec } from "../../template";
import {
  ABSORBING_BOUNDARY_FACES,
  ABSORBING_BOUNDARY_PROFILES,
  absorbingBoundaryDraftFromObject,
} from "../ObjectAbsorbingBoundaryPanelModel";
import {
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  formatLengthAuto,
  LENGTH_UNITS,
  normalizeVector3,
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
      const plateauStart = totalNm - rampNm;
      const u = dNm <= 0 ? 0 : dNm >= rampNm ? 1 : dNm / rampNm;
      void plateauStart;
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
        <span>Effective damping profile &alpha;<sub>eff</sub>(d)</span>
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

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );

  const baseAlpha = useMemo(() => {
    const matRef = sceneObj?.material_ref;
    const mat = matRef ? scene.data?.materials?.find((m) => m.id === matRef) : undefined;
    return typeof mat?.properties?.alpha === "number" ? mat.properties.alpha : 0.008;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const regionOptions = useMemo(() => {
    const base = [{ value: "", label: "Whole object volume" }];
    for (const reg of sceneObj?.regions ?? []) {
      const regId = String(reg.region_id ?? "");
      if (!regId) continue;
      base.push({
        value: regId,
        label: `${reg.name || regId} (${regId})`,
      });
    }
    return base;
  }, [sceneObj?.regions]);

  const baseline = useMemo<AbsorbingBoundarySpecDraft>(() => {
    const parsed = absorbingBoundaryDraftFromObject(sceneObj as never);
    const layers: SalLayerSpecItem[] = parsed.layers.map((l) => ({
      _layerId: l.id,
      name: l.name,
      enabled: l.enabled,
      targetRegionId: l.region,
      contourKind: l.kind,
      faces: l.faces.length > 0 ? l.faces : ["x+", "x-"],
      totalWidth: Number(l.totalWidth) || 50e-9,
      rampWidth: Number(l.rampWidth) || 40e-9,
      maxDampingDelta: Number(l.maxDamping) || 0.5,
      profile: l.profile || "smootherstep",
      customExpression: l.expression || "u * u",
      frame: l.frame === "universe" ? "universe" : "object",
      point: [Number(l.point[0]) || 0, Number(l.point[1]) || 0, Number(l.point[2]) || 0],
      orientation: [
        Number(l.orientation[0]) || 1,
        Number(l.orientation[1]) || 0,
        Number(l.orientation[2]) || 0,
      ],
      radius: Number(l.radius) || 100e-9,
      direction: l.direction,
      boundaryRegionId: l.boundaryRegion,
      distanceExpression: l.distanceExpression || "x",
    }));
    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      exists: Boolean(sceneObj),
      baseAlpha,
      activeLayerIndex: 0,
      layers,
      ...hydrateActiveLayerFields(layers, 0),
    };
  }, [baseAlpha, objectId, sceneObj]);

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
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Remove Absorbing Boundary",
                confirmTitle: () => "Remove spatial absorbing boundary?",
                confirmDescription:
                  "This disables and removes all absorbing damping layers from this object.",
                onDelete: async (ctx) => {
                  const updated = await kernel.api.model.patchObject(objectId, {
                    base_revision: scene.data?.revision ?? null,
                    absorbing_boundary: null,
                  });
                  const rev = fallbackRevision(updated.revision);
                  publishCommittedSceneResource(kernel.resources, updated, rev);
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
      facts: (d): readonly InspectorFact[] => [
        { id: "width", label: "Total width", value: formatLengthAuto(d.totalWidth) },
        { id: "ramp", label: "Ramp width", value: formatLengthAuto(d.rampWidth) },
        {
          id: "peak",
          label: "Peak \u03b1",
          value: (d.baseAlpha + d.maxDampingDelta).toFixed(3),
        },
      ],
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
                  {ctx.draft.layers.map((layer, idx) => (
                    <Button
                      key={layer._layerId}
                      size="sm"
                      type="button"
                      variant={idx === ctx.draft.activeLayerIndex ? "primary" : "secondary"}
                      onClick={() => {
                        const synced = syncActiveLayerIntoList(ctx.draft);
                        ctx.patchDraft({
                          layers: synced,
                          activeLayerIndex: idx,
                          ...hydrateActiveLayerFields(synced, idx),
                        });
                      }}
                    >
                      {idx === ctx.draft.activeLayerIndex ? ctx.draft.layerName : layer.name}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      const synced = syncActiveLayerIntoList(ctx.draft);
                      const nextIdx = synced.length;
                      const created: SalLayerSpecItem = {
                        ...synced[0]!,
                        _layerId: `layer-${nextIdx + 1}-${Date.now().toString(36).slice(-3)}`,
                        name: `Layer ${nextIdx + 1}`,
                      };
                      const nextLayers = [...synced, created];
                      ctx.patchDraft({
                        layers: nextLayers,
                        activeLayerIndex: nextIdx,
                        ...hydrateActiveLayerFields(nextLayers, nextIdx),
                      });
                    }}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Layer</span>
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
              validate: (v) => (v.trim().length === 0 ? "Layer name is required." : null),
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
              options: regionOptions,
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
                { value: "faces", label: "Bounding-box faces (x±, y±, z±)" },
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
              showWhen: (d) => d.contourKind === "plane" || d.contourKind === "cylinder",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Direction vector must be non-zero." : null,
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
              options: regionOptions.filter((r) => r.value !== ""),
              validate: (v) =>
                !v ? "Select an authored region whose boundary anchors the layer." : null,
            },
            {
              key: "distanceExpression",
              type: "expression",
              label: "Signed distance expression d(x, y, z)",
              allowedVariables: ["x", "y", "z"],
              showWhen: (d) => d.contourKind === "expression",
              validate: (v) =>
                v.trim().length === 0 ? "Distance expression is required." : null,
            },
            {
              key: "totalWidth",
              type: "quantity",
              label: "Total absorbing width",
              symbol: <>w<sub>tot</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              validate: (v) => (v > 0 ? null : "Total width must be positive."),
            },
            {
              key: "rampWidth",
              type: "quantity",
              label: "Ramp rise width",
              symbol: <>w<sub>ramp</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              validate: (v, d) =>
                v <= 0
                  ? "Ramp width must be positive."
                  : v > d.totalWidth
                    ? "Ramp width cannot exceed total absorbing width."
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
              symbol: <>&Delta;&alpha;<sub>max</sub></>,
              min: 0.001,
              step: 0.05,
              validate: (v) => (v > 0 ? null : "Δα_max must be strictly positive."),
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
              label: "Custom profile f(u) on u ∈ [0, 1]",
              allowedVariables: ["u"],
              showWhen: (d) => d.profile === "custom",
              validate: (v) => (v.trim().length === 0 ? "Profile expression is required." : null),
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
        cleanMessage: () => "Absorbing boundary configuration matches SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing scene object." : null),
        onApply: async (draft) => {
          const allLayers = syncActiveLayerIntoList(draft);
          const serializedLayers = allLayers.map((l) => {
            let geometry: Record<string, unknown>;
            switch (l.contourKind) {
              case "plane":
                geometry = {
                  kind: "plane",
                  origin: [...l.point],
                  normal: normalizeVector3(l.orientation, [1, 0, 0]),
                };
                break;
              case "cylinder":
                geometry = {
                  kind: "cylinder",
                  center: [...l.point],
                  axis: normalizeVector3(l.orientation, [0, 0, 1]),
                  radius_m: l.radius,
                  direction: l.direction,
                };
                break;
              case "sphere":
                geometry = {
                  kind: "sphere",
                  center: [...l.point],
                  radius_m: l.radius,
                  direction: l.direction,
                };
                break;
              case "region_boundary":
                geometry = { kind: "region_boundary", region_id: l.boundaryRegionId };
                break;
              case "expression":
                geometry = { kind: "expression", expression: l.distanceExpression.trim() };
                break;
              default:
                geometry = { kind: "faces", faces: [...l.faces] };
                break;
            }
            return {
              layer_id: l._layerId,
              name: l.name.trim(),
              enabled: l.enabled,
              ...(l.targetRegionId ? { region_id: l.targetRegionId } : {}),
              total_width_m: l.totalWidth,
              ramp_width_m: l.rampWidth,
              max_damping: l.maxDampingDelta,
              profile: l.profile,
              ...(l.profile === "custom" ? { expression: l.customExpression.trim() } : {}),
              frame: l.frame,
              geometry,
            };
          });

          const updated = await kernel.api.model.patchObject(objectId, {
            base_revision: scene.data?.revision ?? null,
            absorbing_boundary: {
              layers: serializedLayers,
            } as unknown as AbsorbingBoundaryConfig,
          });
          const rev = fallbackRevision(updated.revision);
          publishCommittedSceneResource(kernel.resources, updated, rev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          return true;
        },
      },
    }),
    [baseline.exists, baseline.objectName, kernel.api.model, kernel.resources, objectId, regionOptions, scene.data?.revision],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
