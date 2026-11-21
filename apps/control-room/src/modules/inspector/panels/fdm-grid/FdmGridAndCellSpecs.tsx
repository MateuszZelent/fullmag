"use client";

import {
  Activity,
  Atom,
  Box,
  Compass,
  Grid3x3,
  History,
  Layers,
  Ruler,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import {
  fdmCellCenter,
  useFdmCellPhysicsResource,
  type FdmCellPhysicsTarget,
  type FdmCellQuantitySample,
} from "@/kernel/resources/fdmCellPhysicsResources";
import {
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useFdmRegionMembershipResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorActionContext, InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";

const ELEMENTARY_CHARGE_J = 1.602176634e-19;

type LengthDisplayUnit = "nm" | "µm" | "mm" | "m";

const UNIT_SCALE: Readonly<Record<LengthDisplayUnit, number>> = {
  m: 1,
  mm: 1e3,
  nm: 1e9,
  "µm": 1e6,
};

function fmtTuple3(
  tuple: readonly [number, number, number] | readonly number[],
  unit: LengthDisplayUnit,
): string {
  const mult = UNIT_SCALE[unit];
  const a = Number(((tuple[0] ?? 0) * mult).toFixed(3));
  const b = Number(((tuple[1] ?? 0) * mult).toFixed(3));
  const c = Number(((tuple[2] ?? 0) * mult).toFixed(3));
  return `${a} × ${b} × ${c} ${unit}`;
}

function fmtCoord3(
  tuple: readonly [number, number, number] | readonly number[],
  unit: LengthDisplayUnit,
): string {
  const mult = UNIT_SCALE[unit];
  const a = Number(((tuple[0] ?? 0) * mult).toFixed(2));
  const b = Number(((tuple[1] ?? 0) * mult).toFixed(2));
  const c = Number(((tuple[2] ?? 0) * mult).toFixed(2));
  return `(${a}, ${b}, ${c}) ${unit}`;
}

// ============================================================================
// 1. mesh.grid — FdmGridInspectorSpecPanel (Consolidates 10 grid sub-routes)
// ============================================================================

interface FdmGridDraft {
  displayUnit: LengthDisplayUnit;
  maskOverlayMode: "off" | "by_region" | "support_vs_vacuum" | "unassigned_only";
}

export function FdmGridInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const domainMeta = useDomainMetaResource();
  const membershipRes = useFdmRegionMembershipResource({ enabled: true });
  const multilayerRes = useFdmMultilayerLayoutResource();

  const baseline = useMemo<FdmGridDraft>(
    () => ({ displayUnit: "nm", maskOverlayMode: "off" }),
    [],
  );

  const shape: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.shape ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.shape]);

  const spacing: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.spacing ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.spacing]);

  const origin: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.origin ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.origin]);

  const totalCells = shape[0] * shape[1] * shape[2];
  const voxelVolumeM3 = spacing[0] * spacing[1] * spacing[2];
  const membership = membershipRes.data as unknown as Record<string, unknown> | null;
  const legend = useMemo(() => {
    const raw = membership?.region_legend;
    return Array.isArray(raw)
      ? raw.map((item, idx) => {
          const r = (item ?? {}) as Record<string, unknown>;
          return {
            id: `${String(r.object_id ?? "obj")}:${String(r.region_id ?? idx)}`,
            numericId: Number(r.numeric_id ?? idx + 1),
            objectId: String(r.object_id ?? ""),
            priority: Number(r.priority ?? 0),
            regionId: String(r.region_id ?? "region"),
          };
        })
      : [];
  }, [membership?.region_legend]);

  const activeAssigned = Number(membership?.active_assigned_cells ?? totalCells);
  const activeUnassigned = Number(membership?.active_unassigned_cells ?? 0);
  const inactiveCells = Number(
    membership?.inactive_cells ?? Math.max(0, totalCells - activeAssigned - activeUnassigned),
  );
  const isMultilayer = Boolean(multilayerRes.data?.available);
  const mlLayers = useMemo(
    () =>
      multilayerRes.data?.available
        ? multilayerRes.data.layers.map((layer) => ({
            gridText: layer.native_grid.join(" × "),
            id: layer.layer_id,
            magnetName: layer.magnet_name,
            objectId: layer.object_id,
            transfer: layer.transfer_kind,
            zMinNm: Number(((layer.native_origin[2] ?? 0) * 1e9).toFixed(2)),
          }))
        : [],
    [multilayerRes.data],
  );

  const spec = useMemo<InspectorSpec<FdmGridDraft>>(
    () => ({
      id: "mesh.grid",
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
          { id: "grid", label: "Structured Grid" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          icon: Ruler,
          label: "Edit Cell Size…",
          onRun: (ctx) => {
            ctx.selectNode({
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            });
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:grid",
        icon: Grid3x3,
        kindLabel: isMultilayer
          ? "Multilayer Z-stack FDM discretization"
          : "Regular Cartesian voxel discretization",
        statePill: () =>
          membership
            ? { label: "Materialized", tone: "ok" }
            : { label: "Authoring grid", tone: "neutral" },
        title: () => "Structured FDM Grid",
      },
      facts: (d) => [
        { id: "shape", label: "Shape", value: shape.join(" × ") },
        { id: "cell", label: "Cell size", value: fmtTuple3(spacing, d.displayUnit) },
        {
          id: "fill",
          label: "Active fill",
          value:
            totalCells > 0
              ? `${(((activeAssigned + activeUnassigned) / totalCells) * 100).toFixed(1)}%`
              : null,
        },
        { id: "regions", label: "Regions", value: `${legend.length} numeric` },
      ],
      notices: () =>
        activeUnassigned > 0
          ? [
              {
                id: "unassigned-voxels",
                quickFix: {
                  label: "Highlight unassigned voxels",
                  onApply: (ctx) => ctx.setField("maskOverlayMode", "unassigned_only"),
                },
                text: `${activeUnassigned.toLocaleString("en-US")} active magnetic cells have no semantic region assigned.`,
                title: "Unassigned active voxels",
                tone: "warn",
              },
            ]
          : [],
      sections: [
        {
          defaultOpen: true,
          icon: Ruler,
          id: "dimensions",
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
              format: () =>
                `${shape.join(" × ")} (${totalCells.toLocaleString("en-US")} voxels)`,
              label: "Grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: (d) => fmtTuple3(spacing, d.displayUnit),
              label: "Cell spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: (d) => fmtCoord3(origin, d.displayUnit),
              label: "Grid origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: (d) =>
                fmtTuple3(
                  [shape[0] * spacing[0], shape[1] * spacing[1], shape[2] * spacing[2]],
                  d.displayUnit,
                ),
              label: "Physical span",
              symbol: <>L</>,
              type: "readonly",
            },
            {
              format: () => `${(voxelVolumeM3 * 1e27).toFixed(2)} nm³`,
              label: "Voxel volume",
              symbol: (
                <>
                  V<sub>cell</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          summary: () => shape.join(" × "),
          title: "Grid dimensions & cell size",
        },
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "support-mask",
          live: true,
          rows: [
            {
              key: "maskOverlayMode",
              label: "3D mask overlay",
              options: [
                { label: "Off", value: "off" },
                { label: "By region", value: "by_region" },
                { label: "Active vs vacuum", value: "support_vs_vacuum" },
                { label: "Unassigned", value: "unassigned_only" },
              ],
              type: "segmented",
            },
            {
              format: () => String(membership?.encoding ?? "RLE compressed binary"),
              label: "Mask encoding",
              type: "readonly",
            },
            {
              columns: [
                {
                  header: "ID",
                  id: "id",
                  mono: true,
                  renderCell: (r) => `#${(r as (typeof legend)[number]).numericId}`,
                },
                {
                  header: "Object / Region",
                  id: "owner",
                  renderCell: (r) => {
                    const row = r as (typeof legend)[number];
                    return `${row.objectId} / ${row.regionId}`;
                  },
                },
                {
                  align: "right",
                  header: "Priority",
                  id: "prio",
                  mono: true,
                  renderCell: (r) => String((r as (typeof legend)[number]).priority),
                },
              ],
              label: "Region membership legend",
              onSelectRow: (r, ctx) => {
                const row = r as (typeof legend)[number];
                ctx.selectNode({
                  kind: "object.region",
                  label: row.regionId,
                  nodeId: `model:object:${row.objectId}:region:${row.regionId}`,
                  objectId: row.objectId,
                  ref: null,
                });
              },
              rowKey: (r) => (r as (typeof legend)[number]).id,
              rows: () => legend,
              showWhen: () => legend.length > 0,
              type: "table",
              wide: true,
            },
          ],
          summary: () => `${legend.length} regions`,
          title: "Magnetic support & mask",
        },
        {
          defaultOpen: activeUnassigned > 0,
          icon: Box,
          id: "active-unassigned",
          rows: [
            {
              format: () => activeAssigned.toLocaleString("en-US"),
              label: "Active assigned voxels",
              symbol: (
                <>
                  N<sub>act</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => activeUnassigned.toLocaleString("en-US"),
              label: "Active unassigned voxels",
              symbol: (
                <>
                  N<sub>unass</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => inactiveCells.toLocaleString("en-US"),
              label: "Inactive vacuum voxels",
              symbol: (
                <>
                  N<sub>vac</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          summary: () => `${activeUnassigned} unassigned`,
          title: "Active / unassigned cells",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "multilayer-stack",
          rows: [
            {
              format: () => {
                const common = multilayerRes.data?.common_transform_layout;
                return common
                  ? `${common.shape.join(" × ")} (FFT scratch only — not a material carrier)`
                  : "Single-layer grid";
              },
              label: "Common convolution FFT grid",
              symbol: (
                <>
                  N<sub>FFT</sub>
                </>
              ),
              type: "readonly",
            },
            {
              columns: [
                {
                  header: "Magnet layer",
                  id: "name",
                  renderCell: (r) => (r as (typeof mlLayers)[number]).magnetName,
                },
                {
                  header: "Native grid",
                  id: "grid",
                  mono: true,
                  renderCell: (r) => (r as (typeof mlLayers)[number]).gridText,
                },
                {
                  align: "right",
                  header: "Transfer",
                  id: "transfer",
                  mono: true,
                  renderCell: (r) => (r as (typeof mlLayers)[number]).transfer,
                },
              ],
              label: "Multilayer Z-stack slices",
              onSelectRow: (r, ctx) => {
                const row = r as (typeof mlLayers)[number];
                ctx.selectNode({
                  kind: "mesh.grid.layer",
                  label: row.magnetName,
                  nodeId: `model:mesh:grid:layer:${encodeURIComponent(row.id)}`,
                  objectId: row.objectId,
                  ref: null,
                });
              },
              rowKey: (r) => (r as (typeof mlLayers)[number]).id,
              rows: () => mlLayers,
              showWhen: () => mlLayers.length > 0,
              type: "table",
              wide: true,
            },
          ],
          showWhen: () => isMultilayer,
          summary: () => `${mlLayers.length} Z-layers`,
          title: "Multilayer Z-stack overview",
        },
        {
          defaultOpen: false,
          icon: History,
          id: "provenance",
          rows: [
            {
              copyText: () => domainMeta.data?.generation_id ?? null,
              format: () => domainMeta.data?.generation_id ?? "Pending generation",
              label: "Domain generation ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => String(membership?.grid_fingerprint ?? ""),
              format: () => String(membership?.grid_fingerprint ?? "Pending materialization"),
              label: "Grid fingerprint",
              mono: true,
              type: "readonly",
            },
          ],
          summary: () => String(membership?.grid_fingerprint ?? "Recorded"),
          title: "Provenance",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.maskOverlayMode !== b.maskOverlayMode,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Read-only grid realization · Edit cell size in Discretization & Mesh",
      },
    }),
    [
      activeAssigned,
      activeUnassigned,
      domainMeta.data?.generation_id,
      inactiveCells,
      isMultilayer,
      legend,
      membership,
      mlLayers,
      multilayerRes.data,
      origin,
      shape,
      spacing,
      totalCells,
      voxelVolumeM3,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 2. mesh.grid.layer — FdmGridLayerInspectorSpecPanel (Consolidates 4 children)
// ============================================================================

interface FdmGridLayerDraft {
  highlightLayerMask: boolean;
}

export function FdmGridLayerInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const multilayerRes = useFdmMultilayerLayoutResource();
  const layerId =
    (selection.ref as { layerId?: string } | null)?.layerId ??
    decodeURIComponent(selection.nodeId?.split(":layer:")[1] ?? "");

  const layer = useMemo(
    () =>
      multilayerRes.data?.layers.find(
        (candidate) =>
          candidate.layer_id === layerId || candidate.object_id === selection.objectId,
      ) ??
      multilayerRes.data?.layers[0] ??
      null,
    [layerId, multilayerRes.data?.layers, selection.objectId],
  );

  const baseline = useMemo<FdmGridLayerDraft>(() => ({ highlightLayerMask: false }), []);

  const spec = useMemo<InspectorSpec<FdmGridLayerDraft>>(
    () => ({
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
        extraMenuActions: layer?.object_id
          ? [
              {
                icon: Box,
                id: "open-magnet-object",
                label: "Open magnet object",
                onSelect: (ctx) =>
                  ctx.selectNode({
                    kind: "object.root",
                    label: layer.magnet_name,
                    nodeId: `model:object:${layer.object_id}`,
                    objectId: layer.object_id,
                    ref: null,
                  }),
              },
            ]
          : undefined,
      },
      identity: {
        domain: "mesh",
        entityId: layer?.layer_id ?? layerId,
        icon: Layers,
        kindLabel: "FDM multilayer Z-slice carrier",
        statePill: () =>
          layer ? { label: "Realized", tone: "ok" } : { label: "Not found", tone: "warn" },
        title: () => layer?.magnet_name ?? selection.label ?? "FDM Z-Layer",
      },
      facts: () => [
        {
          id: "grid",
          label: "Native grid",
          value: layer ? layer.native_grid.join(" × ") : null,
        },
        {
          id: "cell",
          label: "Cell size",
          value: layer ? fmtTuple3(layer.native_cell_size, "nm") : null,
        },
        { id: "transfer", label: "Transfer", value: layer?.transfer_kind ?? null },
        {
          id: "active",
          label: "Active cells",
          value:
            layer?.active_cell_count != null
              ? layer.active_cell_count.toLocaleString("en-US")
              : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "native-grid",
          rows: [
            {
              format: () => (layer ? layer.native_grid.join(" × ") : "—"),
              label: "Native grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: () => (layer ? fmtTuple3(layer.native_cell_size, "nm") : "—"),
              label: "Native cell spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: () => (layer ? fmtCoord3(layer.native_origin, "nm") : "—"),
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
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "layer-mask",
          live: true,
          rows: [
            {
              key: "highlightLayerMask",
              label: "Highlight active layer mask in 3D",
              type: "switch",
            },
            {
              format: () =>
                layer?.active_mask_present ? "Explicit binary mask" : "Dense implicit full-box",
              label: "Mask representation",
              type: "readonly",
            },
            {
              format: () => String(layer?.active_cell_count ?? 0),
              label: "Active cells",
              type: "readonly",
            },
            {
              format: () => String(layer?.inactive_cell_count ?? 0),
              label: "Inactive cells",
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
              type: "readonly",
            },
          ],
          title: "Interlayer convolution transfer",
        },
        {
          defaultOpen: false,
          icon: History,
          id: "provenance",
          rows: [
            {
              copyText: () => layer?.native_grid_fingerprint ?? null,
              format: () => layer?.native_grid_fingerprint ?? "Not published",
              label: "Native grid fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => multilayerRes.data?.layout_fingerprint ?? null,
              format: () => multilayerRes.data?.layout_fingerprint ?? "Not published",
              label: "Multilayer layout fingerprint",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Provenance",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.highlightLayerMask !== b.highlightLayerMask,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Multilayer Z-slice execution carrier",
      },
    }),
    [layer, layerId, multilayerRes.data?.layout_fingerprint, selection.label],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. fdm.cell — FdmCellInspectorSpecPanel (Embedded in InspectorTemplate)
// ============================================================================

interface FdmCellDraft {
  energyUnitMode: "density_jm3" | "cell_ev" | "cell_aj";
}

function resolveCellTargetFromSelection(
  selection: SelectionPanelSelection,
  shape: readonly [number, number, number],
  origin: readonly [number, number, number],
  spacing: readonly [number, number, number],
  generationId: string,
): { ijk: [number, number, number]; target: FdmCellPhysicsTarget | null } {
  const ref = selection.ref as Record<string, unknown> | null;
  const nx = Math.max(1, shape[0] || 1);
  const ny = Math.max(1, shape[1] || 1);
  const rawOrdinal = typeof ref?.ordinal === "number" ? ref.ordinal : 0;
  const rawIjk = Array.isArray(ref?.ijk) ? ref.ijk : null;
  const ijk: [number, number, number] =
    rawIjk && rawIjk.length === 3
      ? [Number(rawIjk[0] ?? 0), Number(rawIjk[1] ?? 0), Number(rawIjk[2] ?? 0)]
      : [
          rawOrdinal % nx,
          Math.floor(rawOrdinal / nx) % ny,
          Math.floor(rawOrdinal / (nx * ny)),
        ];

  if (!ref) return { ijk, target: null };
  const cellSizeM: [number, number, number] =
    Array.isArray(ref.cellSizeM) && ref.cellSizeM.length === 3
      ? [
          Number(ref.cellSizeM[0] ?? spacing[0]),
          Number(ref.cellSizeM[1] ?? spacing[1]),
          Number(ref.cellSizeM[2] ?? spacing[2]),
        ]
      : [spacing[0] || 2e-9, spacing[1] || 2e-9, spacing[2] || 2e-9];
  const centerM: [number, number, number] =
    Array.isArray(ref.centerM) && ref.centerM.length === 3
      ? [Number(ref.centerM[0]), Number(ref.centerM[1]), Number(ref.centerM[2])]
      : fdmCellCenter(origin, cellSizeM, ijk);

  return {
    ijk,
    target: {
      cellSizeM,
      centerM,
      generationId: String(ref.generationId ?? generationId),
      gridFingerprint: String(ref.gridFingerprint ?? ""),
      membershipRevision: String(ref.membershipRevision ?? "1:1"),
      meshRevision: Number(ref.meshRevision ?? 1),
      ordinal: rawOrdinal,
    },
  };
}

type SelectionPanelSelection = InspectorPanelProps["selection"];

function formatEnergyRowValue(
  row: FdmCellQuantitySample,
  volumeM3: number,
  mode: FdmCellDraft["energyUnitMode"],
): string {
  if (row.status !== "ready" || row.scalar === null || !Number.isFinite(row.scalar)) {
    return "Not published";
  }
  if (mode === "density_jm3") {
    return `${row.scalar.toExponential(3)} J/m³`;
  }
  const joules = row.scalar * volumeM3;
  if (mode === "cell_ev") {
    return `${(joules / ELEMENTARY_CHARGE_J).toFixed(4)} eV`;
  }
  return `${(joules * 1e18).toFixed(4)} aJ`;
}

function SixNeighborStencil({
  ijk,
  shape,
  origin,
  spacing,
  target,
  ctx,
}: {
  ijk: readonly [number, number, number];
  shape: readonly [number, number, number];
  origin: readonly [number, number, number];
  spacing: readonly [number, number, number];
  target: FdmCellPhysicsTarget | null;
  ctx: InspectorActionContext<FdmCellDraft>;
}): ReactNode {
  const [ix, iy, iz] = ijk;
  const [nx, ny, nz] = shape;
  const neighbors = [
    { delta: [-1, 0, 0] as const, id: "-x", label: "−X" },
    { delta: [1, 0, 0] as const, id: "+x", label: "+X" },
    { delta: [0, -1, 0] as const, id: "-y", label: "−Y" },
    { delta: [0, 1, 0] as const, id: "+y", label: "+Y" },
    { delta: [0, 0, -1] as const, id: "-z", label: "−Z" },
    { delta: [0, 0, 1] as const, id: "+z", label: "+Z" },
  ];

  return (
    <div className="fm-fdm-neighbor-grid" role="group" aria-label="6-neighbor voxel stencil">
      {neighbors.map((nb) => {
        const ni = ix + nb.delta[0];
        const nj = iy + nb.delta[1];
        const nk = iz + nb.delta[2];
        const inBounds = ni >= 0 && ni < nx && nj >= 0 && nj < ny && nk >= 0 && nk < nz;
        const nextOrdinal = ni + nj * nx + nk * nx * ny;
        return (
          <Button
            key={nb.id}
            className="fm-fdm-neighbor-grid__cell"
            disabled={!inBounds}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              if (!inBounds) return;
              ctx.selectNode({
                kind: "fdm.cell",
                label: `FDM Voxel (${ni}, ${nj}, ${nk})`,
                nodeId: `fdm:cell:${nextOrdinal}`,
                objectId: null,
                ref: {
                  cellSizeM: target?.cellSizeM ?? spacing,
                  centerM: fdmCellCenter(origin, spacing, [ni, nj, nk]),
                  generationId: target?.generationId ?? "",
                  gridFingerprint: target?.gridFingerprint ?? "",
                  ijk: [ni, nj, nk],
                  kind: "fdm.cell",
                  membershipRevision: target?.membershipRevision ?? "1:1",
                  meshRevision: target?.meshRevision ?? 1,
                  nodeId: `fdm:cell:${nextOrdinal}`,
                  ordinal: nextOrdinal,
                  type: "fdm-cell",
                } as never,
              });
            }}
          >
            <span>{nb.label}</span>
            <span>{inBounds ? `(${ni}, ${nj}, ${nk})` : "Boundary"}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function FdmCellInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const domainMeta = useDomainMetaResource();
  const shape: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.shape ?? [1, 1, 1];
    return [raw[0] ?? 1, raw[1] ?? 1, raw[2] ?? 1];
  }, [domainMeta.data?.grid?.shape]);
  const spacing: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.spacing ?? [2e-9, 2e-9, 2e-9];
    return [raw[0] ?? 2e-9, raw[1] ?? 2e-9, raw[2] ?? 2e-9];
  }, [domainMeta.data?.grid?.spacing]);
  const origin: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.origin ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.origin]);

  const { ijk, target } = useMemo(
    () =>
      resolveCellTargetFromSelection(
        selection,
        shape,
        origin,
        spacing,
        domainMeta.data?.generation_id ?? "gen",
      ),
    [domainMeta.data?.generation_id, origin, selection, shape, spacing],
  );

  const cellPhysics = useFdmCellPhysicsResource(target);
  const snapshot = cellPhysics.status === "ready" ? cellPhysics.data : null;
  const rows = snapshot?.rows ?? [];
  const materialRows = rows.filter((r) => r.group === "material");
  const magRow = rows.find((r) => r.group === "magnetization") ?? null;
  const energyRows = rows.filter((r) => r.group === "energy");
  const volumeM3 = snapshot?.volumeM3 ?? spacing[0] * spacing[1] * spacing[2];

  const baseline = useMemo<FdmCellDraft>(() => ({ energyUnitMode: "density_jm3" }), []);

  const spec = useMemo<InspectorSpec<FdmCellDraft>>(() => {
    const vec =
      magRow?.status === "ready" && magRow.vector?.length === 3
        ? magRow.vector
        : null;
    const norm = vec ? Math.hypot(vec[0]!, vec[1]!, vec[2]!) : null;

    return {
      id: "fdm.cell",
      header: {
        breadcrumbs: [
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
          { id: "cell", label: `Voxel (${ijk.join(", ")})` },
        ],
        canFitView: true,
      },
      identity: {
        domain: "physics",
        entityId: target ? `cell:${target.ordinal}` : undefined,
        icon: Compass,
        kindLabel: "Interactive FDM voxel readout",
        statePill: () =>
          cellPhysics.status === "error"
            ? { label: "Read error", tone: "err" }
            : snapshot
              ? { label: "Current", tone: "live" }
              : { label: "Waiting", tone: "neutral" },
        title: () => `FDM Voxel (${ijk.join(", ")})`,
      },
      facts: () => [
        { id: "ijk", label: "Indices (i,j,k)", value: `(${ijk.join(", ")})` },
        {
          id: "ordinal",
          label: "Linear index",
          value: target ? target.ordinal.toLocaleString("en-US") : null,
        },
        {
          id: "norm",
          label: "|m|",
          value: norm !== null && Number.isFinite(norm) ? norm.toFixed(4) : null,
        },
        {
          id: "vol",
          label: "Cell volume",
          value: `${(volumeM3 * 1e27).toFixed(2)} nm³`,
        },
      ],
      modeTabs: [
        { id: "physics", label: "Physics" },
        { id: "neighbors", label: "Grid & 6-Neighbors" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Atom,
          id: "material-params",
          modeTabId: "physics",
          rows:
            materialRows.length > 0
              ? materialRows.map((row) => {
                  const cleanUnit =
                    row.unit === "1" || row.unit.toLowerCase() === "dimensionless"
                      ? ""
                      : row.unit;
                  return {
                    format: () =>
                      row.status === "ready" && row.scalar !== null
                        ? `${row.scalar.toExponential(3)}${cleanUnit ? ` ${cleanUnit}` : ""}`
                        : "Not published",
                    label: row.label,
                    symbol:
                      row.id === "mat_ms" ? (
                        <>
                          M<sub>s</sub>
                        </>
                      ) : row.id === "mat_aex" ? (
                        <>
                          A<sub>ex</sub>
                        </>
                      ) : row.id === "mat_alpha" ? (
                        <>&alpha;</>
                      ) : undefined,
                    type: "readonly" as const,
                  };
                })
              : [
                  {
                    format: () => "No material coefficients published for this voxel",
                    label: "Material coefficients",
                    type: "readonly",
                  },
                ],
          title: "Material coefficients",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "magnetization",
          modeTabId: "physics",
          rows: [
            {
              format: () =>
                vec
                  ? `(${vec[0]!.toFixed(4)}, ${vec[1]!.toFixed(4)}, ${vec[2]!.toFixed(4)})`
                  : "Not published",
              label: "Reduced magnetization",
              symbol: <>m</>,
              type: "readonly",
            },
            {
              format: () => (norm !== null ? norm.toFixed(6) : "Not published"),
              label: "Vector norm",
              symbol: <>|m|</>,
              type: "readonly",
            },
          ],
          title: "Magnetization vector",
        },
        {
          defaultOpen: true,
          icon: Zap,
          id: "energies",
          live: true,
          modeTabId: "physics",
          rows: [
            {
              key: "energyUnitMode",
              label: "Energy quantity",
              options: [
                { label: "Density [J/m³]", value: "density_jm3" },
                { label: "Voxel [eV]", value: "cell_ev" },
                { label: "Voxel [aJ]", value: "cell_aj" },
              ],
              type: "segmented",
            },
            {
              columns: [
                {
                  header: "Term",
                  id: "term",
                  renderCell: (r) => (r as FdmCellQuantitySample).label,
                },
                {
                  align: "right",
                  header: "Value",
                  id: "val",
                  mono: true,
                  renderCell: () => null,
                },
              ],
              label: "Local energy breakdown",
              rowKey: (r) => (r as FdmCellQuantitySample).id,
              rows: () => [],
              showWhen: () => false,
              type: "table",
            },
            ...energyRows.map((row) => ({
              format: (d: FdmCellDraft) => formatEnergyRowValue(row, volumeM3, d.energyUnitMode),
              label: row.label,
              type: "readonly" as const,
            })),
          ],
          title: "Cell energies",
        },
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "stencil",
          modeTabId: "neighbors",
          rows: [
            {
              format: () => fmtCoord3(target?.centerM ?? origin, "nm"),
              label: "Voxel center",
              symbol: (
                <>
                  r<sub>c</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => fmtTuple3(target?.cellSizeM ?? spacing, "nm"),
              label: "Voxel size",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              label: "6-neighbor stencil",
              render: (ctx) => (
                <SixNeighborStencil
                  ctx={ctx}
                  ijk={ijk}
                  origin={origin}
                  shape={shape}
                  spacing={spacing}
                  target={target}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Voxel coordinates & 6-neighbor stencil",
        },
      ],
      details: () => [
        { label: "Run ID", mono: true, value: snapshot?.runId ?? null },
        {
          label: "Grid fingerprint",
          mono: true,
          value: target?.gridFingerprint || null,
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Live FDM voxel probe · Click a neighbor to step through the grid",
      },
    };
  }, [
    cellPhysics.status,
    energyRows,
    ijk,
    magRow,
    materialRows,
    origin,
    shape,
    snapshot,
    spacing,
    target,
    volumeM3,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
