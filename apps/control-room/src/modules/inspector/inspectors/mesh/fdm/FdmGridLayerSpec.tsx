"use client";

import {
  Activity,
  Box,
  Eye,
  Grid3x3,
  History,
  Layers,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import { DATA_DOMAIN_META_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type {
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  resolveVisualizationTargetFromSelection,
  targetForFdmNativeLayer,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  SpecInspectorHost,
  type InspectorActionContext,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";

import {
  FDM_VIZ_FIELD_KEYS,
  fmtCoord3,
  fmtTuple3,
  hasVizDraftChanges,
  sanitizeDisplayReason,
  useDomainMetaResourceSafe,
  useFdmMultilayerLayerActiveMasksResourceSafe,
  useFdmMultilayerLayoutResourceSafe,
  useFdmRegionMembershipResourceSafe,
  useSafeFdmTargetVisualization,
  useSceneResourceSafe,
  useSessionScopeKeySafe,
  useSessionStatusDataSafe,
  type FdmLayerLayoutResource,
  type FdmTargetVizFields,
  type LengthDisplayUnit,
} from "./fdmShared";

export interface FdmGridLayerDraft extends FdmTargetVizFields {
  displayUnit: LengthDisplayUnit;
}

interface LayerSummaryRecord {
  layer_id?: string;
  object_id?: string;
  active_cell_count?: number;
  active_cells?: number;
  inactive_cell_count?: number;
  inactive_cells?: number;
  dominant_object_id?: string;
  dominant_object?: string;
}

function resolveLayerSummaryFromMembership(
  membership: FdmRegionMembershipResource | null | undefined,
  layer: FdmLayerLayoutResource | null,
  layerId: string,
): LayerSummaryRecord | null {
  if (!membership) return null;
  const raw = (membership as unknown as { layer_summaries?: unknown }).layer_summaries;
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as LayerSummaryRecord;
    if (
      (rec.layer_id && (rec.layer_id === layer?.layer_id || rec.layer_id === layerId)) ||
      (layer?.object_id && rec.object_id === layer.object_id)
    ) {
      return rec;
    }
  }
  return null;
}

function extractLayerIdFromSelection(selection: Selection): string {
  const ref = selection.ref;
  if (ref?.type === "fdm-domain") {
    if (ref.layerId) return ref.layerId;
    if (ref.visualizationTargetId.startsWith("fdm-native-layer:")) {
      return decodeURIComponent(
        ref.visualizationTargetId.slice("fdm-native-layer:".length),
      );
    }
  }
  const genericLayerId = (ref as { layerId?: string } | null)?.layerId;
  if (genericLayerId) return genericLayerId;
  const rawNodeSuffix = selection.nodeId?.split(":layer:")[1]?.split(":")[0] ?? "";
  return rawNodeSuffix ? decodeURIComponent(rawNodeSuffix) : "";
}

export function FdmGridLayerInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const domainMeta = useDomainMetaResourceSafe();
  const multilayerRes = useFdmMultilayerLayoutResourceSafe();
  const membershipRes = useFdmRegionMembershipResourceSafe({ enabled: true });
  const activeMasksRes = useFdmMultilayerLayerActiveMasksResourceSafe(
    multilayerRes.data,
  );
  const sceneRes = useSceneResourceSafe();
  const sessionStatusData = useSessionStatusDataSafe();
  const sessionScopeKey = useSessionScopeKeySafe();

  const layerId = useMemo(
    () => extractLayerIdFromSelection(selection),
    [selection],
  );

  const layer = useMemo<FdmLayerLayoutResource | null>(
    () =>
      multilayerRes.data?.layers.find(
        (candidate) =>
          candidate.layer_id === layerId ||
          (Boolean(selection.objectId) &&
            candidate.object_id === selection.objectId),
      ) ??
      (layerId ? null : (multilayerRes.data?.layers[0] ?? null)),
    [layerId, multilayerRes.data?.layers, selection.objectId],
  );

  const resolvedLayerId = layer?.layer_id ?? layerId;

  const layerVizTarget = useMemo<VisualizationTargetRef | null>(() => {
    const fromSelection = resolveVisualizationTargetFromSelection(selection);
    if (fromSelection?.kind === "fdm-native-layer") {
      return fromSelection;
    }
    if (resolvedLayerId) {
      return targetForFdmNativeLayer(
        resolvedLayerId,
        layer?.magnet_name ?? selection.label,
      );
    }
    return null;
  }, [layer?.magnet_name, resolvedLayerId, selection]);

  const {
    applyVizPatch,
    hasPersistedOverride,
    hydratedVizFields,
    resetVizTarget,
  } = useSafeFdmTargetVisualization(layerVizTarget, "surface", "m");

  const baseline = useMemo<FdmGridLayerDraft>(
    () => ({
      ...hydratedVizFields,
      displayUnit: "nm",
    }),
    [hydratedVizFields],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof FdmGridLayerDraft & string>(
      key: K,
      value: FdmGridLayerDraft[K],
      helpers: { draft: FdmGridLayerDraft },
    ) => {
      if (!FDM_VIZ_FIELD_KEYS.has(key)) return;
      const nextDraft: FdmGridLayerDraft = { ...helpers.draft, [key]: value };
      applyVizPatch(nextDraft);
    },
    [applyVizPatch],
  );

  const executeBuildFdmGrid = useCallback(async () => {
    if (!kernel?.commands?.execute) return;
    const statusKey =
      sessionStatusHooks.SESSION_STATUS_RESOURCE_KEY ?? "session:status";
    const resourceData: Record<string, unknown> = {};
    if (domainMeta.data) {
      resourceData[DATA_DOMAIN_META_PATH] = domainMeta.data;
    }
    if (sessionStatusData) {
      resourceData[statusKey] = sessionStatusData;
    }
    if (sceneRes.data) {
      resourceData[MODEL_SCENE_PATH] = sceneRes.data;
    }
    await kernel.commands.execute(
      "grid.build-fdm",
      createCommandContext("inspector", kernel, {
        resourceData:
          Object.keys(resourceData).length > 0 ? resourceData : undefined,
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "mesh.grid.layer",
      }),
    );
  }, [domainMeta.data, kernel, sceneRes.data, sessionScopeKey, sessionStatusData]);

  const layerMetrics = useMemo(() => {
    const summary = resolveLayerSummaryFromMembership(
      membershipRes.data,
      layer,
      resolvedLayerId,
    );
    const decodedMask = resolvedLayerId
      ? activeMasksRes.data?.masks?.get(resolvedLayerId) ?? null
      : null;

    let maskActiveCount: number | null = null;
    let maskInactiveCount: number | null = null;
    if (decodedMask) {
      let count = 0;
      for (let i = 0; i < decodedMask.activeMask.length; i += 1) {
        if (decodedMask.activeMask[i] !== 0) count += 1;
      }
      maskActiveCount = count;
      maskInactiveCount = Math.max(0, decodedMask.cellCount - count);
    }

    const activeCells =
      summary?.active_cell_count ??
      summary?.active_cells ??
      maskActiveCount ??
      layer?.active_cell_count ??
      null;
    const inactiveCells =
      summary?.inactive_cell_count ??
      summary?.inactive_cells ??
      maskInactiveCount ??
      layer?.inactive_cell_count ??
      null;

    const ownerId =
      summary?.dominant_object_id ??
      summary?.dominant_object ??
      layer?.object_id ??
      selection.objectId ??
      null;
    const matchedObject = ownerId
      ? sceneRes.data?.objects?.find((obj) => obj.id === ownerId) ?? null
      : null;
    const dominantObject = matchedObject?.name
      ? `${matchedObject.name} (${matchedObject.id})`
      : layer?.magnet_name && layer?.object_id && layer.magnet_name !== layer.object_id
        ? `${layer.magnet_name} (${layer.object_id})`
        : (ownerId ?? layer?.magnet_name ?? "Not published");

    return {
      activeCells,
      dominantObject,
      inactiveCells,
      ownerId,
    };
  }, [
    activeMasksRes.data?.masks,
    layer,
    membershipRes.data,
    resolvedLayerId,
    sceneRes.data?.objects,
    selection.objectId,
  ]);

  const spec = useMemo<InspectorSpec<FdmGridLayerDraft>>(() => {
    const layoutData: FdmMultilayerLayoutResource | null =
      multilayerRes.data ?? null;
    return {
      id: "mesh.grid.layer",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "grid",
            label: "Structured Grid",
            selection: {
              kind: "mesh.grid",
              label: "Structured Grid",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: null,
            },
          },
          { id: "layer", label: layer?.magnet_name ?? selection.label ?? "Layer" },
        ],
        canFitView: true,
        extraMenuActions: [
          ...(layer?.object_id
            ? [
                {
                  icon: Box,
                  id: "open-magnet-object",
                  label: "Open magnet object",
                  onSelect: (ctx: InspectorActionContext<FdmGridLayerDraft>) =>
                    ctx.selectNode({
                      kind: "object.root",
                      label: layer.magnet_name,
                      nodeId: `model:object:${layer.object_id}`,
                      objectId: layer.object_id,
                      ref: null,
                    }),
                },
              ]
            : []),
          {
            icon: RefreshCw,
            id: "rebuild-fdm-grid",
            label: "Build FDM Grid",
            onSelect: () => executeBuildFdmGrid(),
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: resolvedLayerId || undefined,
        icon: Layers,
        kindLabel: "FDM multilayer Z-slice carrier",
        statePill: () =>
          layer
            ? { label: "Realized", tone: "ok" }
            : { label: "Not found", tone: "warn" },
        title: () => layer?.magnet_name ?? selection.label ?? "FDM Z-Layer",
      },
      facts: (d) => [
        {
          id: "grid",
          label: "Native grid",
          value: layer ? layer.native_grid.join(" × ") : null,
        },
        {
          id: "cell",
          label: "Cell size",
          value: layer ? fmtTuple3(layer.native_cell_size, d.displayUnit) : null,
        },
        { id: "transfer", label: "Transfer", value: layer?.transfer_kind ?? null },
        {
          id: "active",
          label: "Active cells",
          value:
            layerMetrics.activeCells !== null
              ? layerMetrics.activeCells.toLocaleString("en-US")
              : null,
        },
      ],
      notices: () =>
        !layoutData || !layoutData.available
          ? [
              {
                id: "multilayer-not-published",
                text: sanitizeDisplayReason(
                  layoutData?.unavailable_reason,
                  "Native multilayer layout is not published for the current session.",
                ),
                title: "Multilayer layout not active",
                tone: "warn",
              },
            ]
          : !layer
            ? [
                {
                  id: "layer-not-found",
                  text: "The selected native Z-layer is not present in the current multilayer layout.",
                  title: "Layer not found",
                  tone: "warn",
                },
              ]
            : [],
      sections: [
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "native-grid",
          live: true,
          rows: [
            {
              key: "displayUnit",
              label: "Display length unit",
              options: [
                { label: "nm", value: "nm" },
                { label: "µm", value: "µm" },
                { label: "mm", value: "mm" },
                { label: "m", value: "m" },
              ],
              type: "segmented",
            },
            {
              format: () => layerMetrics.dominantObject,
              label: "Dominant object",
              type: "readonly",
            },
            {
              format: () => (layer ? layer.native_grid.join(" × ") : "—"),
              label: "Native grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: (d) =>
                layer ? fmtTuple3(layer.native_cell_size, d.displayUnit) : "—",
              label: "Native cell spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: (d) =>
                layer ? fmtCoord3(layer.native_origin, d.displayUnit) : "—",
              label: "Layer origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          title: "Native layer grid & Z-span",
        },
        ...(layerVizTarget
          ? [
              {
                defaultOpen: true,
                icon: Eye,
                id: "layer-visualization",
                live: true,
                rows: [
                  {
                    key: "visible" as const,
                    label: "Show layer carrier in 3D",
                    type: "switch" as const,
                  },
                  {
                    key: "boundsVisible" as const,
                    label: "Show layer bounds",
                    type: "switch" as const,
                  },
                  {
                    key: "renderMode" as const,
                    label: "3D render mode",
                    options: [
                      { label: "Shaded", value: "surface" },
                      { label: "Edges", value: "surface+edges" },
                      { label: "Wireframe", value: "wireframe" },
                      { label: "Points", value: "points" },
                      { label: "Off", value: "off" },
                    ],
                    type: "segmented" as const,
                  },
                  {
                    key: "surfaceOpacityPercent" as const,
                    label: "Surface opacity",
                    max: 100,
                    min: 0,
                    step: 5,
                    type: "range" as const,
                    unitSuffix: "%",
                  },
                  {
                    key: "wireframeOpacityPercent" as const,
                    label: "Wireframe opacity",
                    max: 100,
                    min: 0,
                    step: 5,
                    type: "range" as const,
                    unitSuffix: "%",
                  },
                  {
                    key: "activeQuantityId" as const,
                    label: "Field quantity",
                    options: [
                      { label: "Magnetization m", value: "m" },
                      { label: "Demagnetizing field H_demag", value: "H_demag" },
                      { label: "Effective field H_eff", value: "H_eff" },
                      { label: "Uniform solid tint", value: "solid" },
                    ],
                    type: "select" as const,
                  },
                  {
                    key: "scalarColorPalette" as const,
                    label: "Scalar colormap",
                    options: [
                      { label: "Viridis", value: "viridis" },
                      { label: "Coolwarm", value: "coolwarm" },
                      { label: "Inferno", value: "inferno" },
                      { label: "Magma", value: "magma" },
                      { label: "Cividis", value: "cividis" },
                    ],
                    type: "select" as const,
                  },
                  {
                    key: "vectorsVisible" as const,
                    label: "Show layer field vectors",
                    type: "switch" as const,
                  },
                  {
                    integer: true,
                    key: "vectorBudget" as const,
                    label: "Vector glyph budget",
                    max: 50000,
                    min: 50,
                    showWhen: (d: FdmGridLayerDraft) => d.vectorsVisible,
                    type: "number" as const,
                  },
                ],
                title: "3D layer visualization",
              },
            ]
          : []),
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "layer-mask",
          rows: [
            {
              format: () =>
                layer?.active_mask_present
                  ? "Explicit binary mask"
                  : "Dense implicit full-box",
              label: "Mask representation",
              type: "readonly",
            },
            {
              format: () =>
                layerMetrics.activeCells !== null
                  ? layerMetrics.activeCells.toLocaleString("en-US")
                  : "Not published",
              label: "Active cells",
              type: "readonly",
            },
            {
              format: () =>
                layerMetrics.inactiveCells !== null
                  ? layerMetrics.inactiveCells.toLocaleString("en-US")
                  : "Not published",
              label: "Inactive cells",
              type: "readonly",
            },
            {
              copyText: () => layer?.mask_provenance ?? null,
              format: () =>
                layer?.mask_provenance ?? "Implicit dense carrier",
              label: "Mask provenance",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Layer active mask",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "transfer",
          rows: [
            {
              format: () => layer?.transfer_kind ?? "identity",
              label: "Convolution transfer operator",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                layer?.convolution_grid
                  ? layer.convolution_grid.join(" × ")
                  : "Not published",
              label: "Convolution grid",
              mono: true,
              type: "readonly",
            },
            {
              format: (d) =>
                layer?.convolution_cell_size
                  ? fmtTuple3(layer.convolution_cell_size, d.displayUnit)
                  : "Not published",
              label: "Convolution cell size",
              type: "readonly",
            },
          ],
          title: "Interlayer convolution transfer",
        },
        {
          defaultOpen: true,
          icon: History,
          id: "provenance",
          rows: [
            {
              copyText: () => layer?.layer_id ?? null,
              format: () => layer?.layer_id ?? "Not published",
              label: "Layer ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => layer?.object_id ?? null,
              format: () => layer?.object_id ?? "Not published",
              label: "Object ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => layer?.native_grid_fingerprint ?? null,
              format: () => layer?.native_grid_fingerprint ?? "Not published",
              label: "Native grid fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => layoutData?.layout_fingerprint ?? null,
              format: () => layoutData?.layout_fingerprint ?? "Not published",
              label: "Multilayer layout fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                layoutData?.layout_revision != null
                  ? String(layoutData.layout_revision)
                  : "Not published",
              label: "Layout revision",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Provenance",
        },
      ],
      commitBar: layerVizTarget
        ? {
            hasOverrides: (d, b) =>
              hasPersistedOverride || hasVizDraftChanges(d, b),
            mode: "liveViewport",
            onResetDisplay: resetVizTarget,
            statusMessage: "Live multilayer Z-slice 3D display",
          }
        : {
            mode: "readOnly",
            statusMessage: () => "Multilayer Z-slice execution carrier",
          },
    };
  }, [
    executeBuildFdmGrid,
    hasPersistedOverride,
    layer,
    layerMetrics.activeCells,
    layerMetrics.dominantObject,
    layerMetrics.inactiveCells,
    layerVizTarget,
    multilayerRes.data,
    resetVizTarget,
    resolvedLayerId,
    selection.label,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}
