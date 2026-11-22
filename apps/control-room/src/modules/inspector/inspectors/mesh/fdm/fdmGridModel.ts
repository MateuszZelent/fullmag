import type { ReactNode } from "react";

import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import type {
  FdmDomainSelectionScope,
  Selection,
} from "@/kernel/selection/selectionTypes";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveVisualizationTargetFromSelection,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import type {
  InspectorBreadcrumbItem,
  InspectorNotice,
  InspectorRowSpec,
} from "@/modules/inspector/shared";

import type { FdmGridLegendEntry } from "../../../panels/fdm-grid/fdmGridInspectorModel";
import {
  fmtCoord3,
  fmtTuple3,
  sameTupleApprox,
  sanitizeDisplayReason,
  tuple3OrNull,
  type FdmTargetVizFields,
  type LengthDisplayUnit,
} from "./fdmShared";

export interface FdmGridDraft extends FdmTargetVizFields {
  displayUnit: LengthDisplayUnit;
}

export interface ValidatedSupportSummary {
  activeCellCount: number;
  activeAssignedCellCount: number;
  activeUnassignedCellCount: number;
  inactiveCellCount: number;
  boundsMinM: [number, number, number];
  boundsMaxM: [number, number, number];
}

export function resolveValidatedMagneticSupport(
  membership: FdmRegionMembershipResource | null | undefined,
): ValidatedSupportSummary | null {
  const support = membership?.magnetic_support;
  if (!membership || !support) return null;
  if (
    support.semantic_role !== "magnetic-support" ||
    support.grid_fingerprint !== membership.grid_fingerprint
  ) {
    return null;
  }
  const boundsMinM = tuple3OrNull(support.bounds_min_m);
  const boundsMaxM = tuple3OrNull(support.bounds_max_m);
  if (
    !boundsMinM ||
    !boundsMaxM ||
    boundsMinM.some((val, idx) => val > boundsMaxM[idx])
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(support.active_cell_count) ||
    support.active_cell_count < 0 ||
    !Number.isSafeInteger(support.active_unassigned_cell_count) ||
    support.active_unassigned_cell_count < 0 ||
    !Number.isSafeInteger(support.inactive_cell_count) ||
    support.inactive_cell_count < 0 ||
    support.active_unassigned_cell_count > support.active_cell_count
  ) {
    return null;
  }
  if (
    typeof membership.cell_count === "number" &&
    support.active_cell_count + support.inactive_cell_count !==
      membership.cell_count
  ) {
    return null;
  }
  return {
    activeAssignedCellCount: Math.max(
      0,
      support.active_cell_count - support.active_unassigned_cell_count,
    ),
    activeCellCount: support.active_cell_count,
    activeUnassignedCellCount: support.active_unassigned_cell_count,
    boundsMaxM,
    boundsMinM,
    inactiveCellCount: support.inactive_cell_count,
  };
}

export function checkFdmMembershipCompatible(
  domain: DomainMetaResource | null | undefined,
  membership: FdmRegionMembershipResource | null | undefined,
  shape: readonly [number, number, number],
  origin: readonly [number, number, number],
  spacing: readonly [number, number, number],
  totalCells: number,
): boolean {
  if (!membership) return false;
  if ((membership.freshness ?? "current").trim().toLowerCase() !== "current") {
    return false;
  }
  if (
    domain?.generation_id &&
    membership.domain_generation_id &&
    membership.domain_generation_id !== domain.generation_id
  ) {
    return false;
  }
  if (
    Array.isArray(membership.counts) &&
    (membership.counts.length < 3 ||
      membership.counts[0] !== shape[0] ||
      membership.counts[1] !== shape[1] ||
      membership.counts[2] !== shape[2])
  ) {
    return false;
  }
  if (
    typeof membership.cell_count === "number" &&
    totalCells > 0 &&
    membership.cell_count !== totalCells
  ) {
    return false;
  }
  if (
    Array.isArray(membership.origin_m) &&
    !sameTupleApprox(membership.origin_m, origin)
  ) {
    return false;
  }
  if (
    Array.isArray(membership.cell_m) &&
    !sameTupleApprox(membership.cell_m, spacing)
  ) {
    return false;
  }
  return true;
}

export function resolveGridSubScope(selection: Selection): {
  scope: FdmDomainSelectionScope;
  regionId: string | null;
  ownerObjectId: string | null;
} {
  const ref = selection.ref;
  if (ref?.type === "fdm-domain") {
    const scope = ref.kind === "mesh.grid.common" ? "common" : ref.scope;
    return {
      ownerObjectId: ref.objectId?.trim() || selection.objectId?.trim() || null,
      regionId: ref.regionId?.trim() || null,
      scope,
    };
  }
  const kind = selection.kind ?? "";
  if (
    kind === "mesh.grid.universe-outside-support" ||
    selection.nodeId?.endsWith(":universe-outside-support")
  ) {
    return { ownerObjectId: null, regionId: null, scope: "universe-outside-support" };
  }
  if (kind === "mesh.grid.common" || selection.nodeId?.endsWith(":common")) {
    return { ownerObjectId: null, regionId: null, scope: "common" };
  }
  if (
    kind === "mesh.grid.magnetic-support" ||
    selection.nodeId?.endsWith(":magnetic-support")
  ) {
    return { ownerObjectId: null, regionId: null, scope: "magnetic-support" };
  }
  if (
    kind === "mesh.grid.active-unassigned" ||
    selection.nodeId?.endsWith(":active-unassigned")
  ) {
    return { ownerObjectId: null, regionId: null, scope: "active-unassigned" };
  }
  if (kind === "mesh.grid.mask" || selection.nodeId?.endsWith(":mask")) {
    return { ownerObjectId: null, regionId: null, scope: "mask" };
  }
  if (kind === "mesh.grid.provenance" || selection.nodeId?.endsWith(":provenance")) {
    return { ownerObjectId: null, regionId: null, scope: "provenance" };
  }
  if (kind === "mesh.grid.descriptor" || selection.nodeId?.endsWith(":descriptor")) {
    return { ownerObjectId: null, regionId: null, scope: "descriptor" };
  }
  if (kind === "mesh.grid.layers" || selection.nodeId?.endsWith(":layers")) {
    return { ownerObjectId: null, regionId: null, scope: "layers" };
  }
  const genericRef = (ref ?? null) as {
    objectId?: string;
    regionId?: string;
    scope?: FdmDomainSelectionScope;
  } | null;
  if (
    kind === "mesh.grid.region" ||
    genericRef?.regionId ||
    selection.nodeId?.includes(":region:")
  ) {
    const parsedFromNode = selection.nodeId?.includes(":region:")
      ? decodeURIComponent(selection.nodeId.split(":region:")[1] ?? "")
      : null;
    return {
      ownerObjectId:
        genericRef?.objectId?.trim() || selection.objectId?.trim() || null,
      regionId: genericRef?.regionId?.trim() || parsedFromNode || null,
      scope: "region",
    };
  }
  return {
    ownerObjectId: genericRef?.objectId?.trim() || selection.objectId?.trim() || null,
    regionId: genericRef?.regionId?.trim() || null,
    scope: genericRef?.scope ?? "domain",
  };
}

export function resolveGridVisualizationTarget(
  selection: Selection,
  scope: FdmDomainSelectionScope,
): VisualizationTargetRef | null {
  if (scope === "common") {
    return null;
  }
  if (scope === "universe-outside-support") {
    return AIRBOX_VISUALIZATION_TARGET;
  }
  const fromSelection = resolveVisualizationTargetFromSelection(selection);
  if (fromSelection) {
    return fromSelection;
  }
  return {
    id: "fdm-domain",
    kind: "fdm-domain",
    label: selection.label || "Structured Grid",
  };
}

export function buildSupportVisualizationRows(
  vizTarget: VisualizationTargetRef | null,
  isAirboxTarget: boolean,
): InspectorRowSpec<FdmGridDraft>[] {
  if (!vizTarget) return [];
  return [
    {
      key: "visible",
      label: isAirboxTarget
        ? "Show Airbox outside-support in 3D"
        : "Show structured grid in 3D",
      type: "switch",
    },
    {
      key: "boundsVisible",
      label: isAirboxTarget
        ? "Show Airbox extent bounds"
        : "Show domain bounds",
      type: "switch",
    },
    {
      key: "renderMode",
      label: "3D render mode",
      options: isAirboxTarget
        ? [
            { label: "Wireframe", value: "wireframe" },
            { label: "Points", value: "points" },
            { label: "Off", value: "off" },
          ]
        : [
            { label: "Shaded", value: "surface" },
            { label: "Edges", value: "surface+edges" },
            { label: "Wireframe", value: "wireframe" },
            { label: "Points", value: "points" },
            { label: "Off", value: "off" },
          ],
      type: "segmented",
    },
    {
      key: "wireframeOpacityPercent",
      label: "Grid wireframe opacity",
      max: 100,
      min: 0,
      step: 5,
      type: "range",
      unitSuffix: "%",
    },
    ...(isAirboxTarget
      ? []
      : ([
          {
            key: "surfaceOpacityPercent",
            label: "Surface opacity",
            max: 100,
            min: 0,
            step: 5,
            type: "range",
            unitSuffix: "%",
          },
        ] satisfies InspectorRowSpec<FdmGridDraft>[])),
    {
      key: "activeQuantityId",
      label: isAirboxTarget ? "Observation quantity" : "Field quantity",
      options: isAirboxTarget
        ? [
            { label: "Demagnetizing field H_demag", value: "H_demag" },
            { label: "Magnetic flux density B_demag", value: "B_demag" },
            { label: "Effective field H_eff", value: "H_eff" },
            { label: "Antenna Oersted field H_ant", value: "H_ant" },
          ]
        : [
            { label: "Magnetization m", value: "m" },
            { label: "Demagnetizing field H_demag", value: "H_demag" },
            { label: "Effective field H_eff", value: "H_eff" },
            { label: "Uniform solid tint", value: "solid" },
          ],
      type: "select",
    },
    ...(isAirboxTarget
      ? []
      : ([
          {
            key: "scalarColorPalette",
            label: "Scalar colormap",
            options: [
              { label: "Viridis", value: "viridis" },
              { label: "Coolwarm", value: "coolwarm" },
              { label: "Inferno", value: "inferno" },
              { label: "Magma", value: "magma" },
              { label: "Cividis", value: "cividis" },
            ],
            type: "select",
          },
        ] satisfies InspectorRowSpec<FdmGridDraft>[])),
    {
      key: "vectorsVisible",
      label: "Show 3D field vectors",
      type: "switch",
    },
    {
      integer: true,
      key: "vectorBudget",
      label: "Vector glyph budget",
      max: 50000,
      min: 50,
      showWhen: (d) => d.vectorsVisible,
      type: "number",
    },
  ];
}

export function buildFdmGridNotices(input: {
  buildFeedback: { tone: "info" | "warn" | "err"; text: string } | null;
  domainErrorMessage: string | undefined;
  domainStatus: string;
  executeBuildFdmGrid: () => Promise<void>;
  isMembershipCompatible: boolean;
  isMultilayer: boolean;
  membership: FdmRegionMembershipResource | null;
  membershipErrorMessage: string | undefined;
  membershipStatus: string;
  scope: FdmDomainSelectionScope;
  selectedRegion: FdmGridLegendEntry | null;
  validatedSupport: ValidatedSupportSummary | null;
}): InspectorNotice<FdmGridDraft>[] {
  const {
    buildFeedback,
    domainErrorMessage,
    domainStatus,
    executeBuildFdmGrid,
    isMembershipCompatible,
    isMultilayer,
    membership,
    membershipErrorMessage,
    membershipStatus,
    scope,
    selectedRegion,
    validatedSupport,
  } = input;

  const list: InspectorNotice<FdmGridDraft>[] = [];
  if (buildFeedback) {
    list.push({
      id: "fdm-grid-build-feedback",
      text: buildFeedback.text,
      tone: buildFeedback.tone,
    });
  }
  if (domainStatus === "error" || membershipStatus === "error") {
    const errMsg = sanitizeDisplayReason(
      membershipErrorMessage ?? domainErrorMessage,
      "FDM grid resources could not be loaded.",
    );
    list.push({
      id: "fdm-grid-error",
      quickFix: {
        label: "Build FDM Grid",
        onApply: () => executeBuildFdmGrid(),
      },
      text: errMsg,
      title: "Grid resource error",
      tone: "err",
    });
  } else if (membership && !isMembershipCompatible) {
    list.push({
      id: "fdm-membership-stale",
      quickFix: {
        label: "Build FDM Grid",
        onApply: () => executeBuildFdmGrid(),
      },
      text: "FDM region membership is stale or no longer matches the structured grid.",
      title: "Stale membership mask",
      tone: "warn",
    });
  } else if (
    !membership &&
    !isMultilayer &&
    domainStatus === "ready" &&
    scope !== "domain" &&
    scope !== "descriptor"
  ) {
    list.push({
      id: "fdm-membership-missing",
      quickFix: {
        label: "Build FDM Grid",
        onApply: () => executeBuildFdmGrid(),
      },
      text: "FDM region membership is not materialized yet; build the FDM grid to classify magnetic support.",
      title: "Membership not materialized",
      tone: "warn",
    });
  }
  if (
    (scope === "magnetic-support" ||
      scope === "active-unassigned" ||
      scope === "universe-outside-support") &&
    membership &&
    !validatedSupport
  ) {
    list.push({
      id: "support-summary-withheld",
      text: "The canonical magnetic-support summary is not published or does not match the current grid; support facts are withheld.",
      title: "Support summary withheld",
      tone: "warn",
    });
  }
  if (scope === "region" && membership && !selectedRegion) {
    list.push({
      id: "selected-region-missing",
      text: "The selected FDM region is not present in the current membership legend.",
      title: "Region not in current legend",
      tone: "warn",
    });
  }
  if (scope === "common") {
    list.push({
      id: "common-fft-scratch-notice",
      text: "Diagnostic FFT scratch layout; the common convolution grid is not a physical material mesh.",
      title: "FFT scratch carrier",
      tone: "info",
    });
  }
  if (validatedSupport && validatedSupport.activeUnassignedCellCount > 0) {
    list.push({
      id: "unassigned-voxels",
      quickFix: {
        label: "Build FDM Grid",
        onApply: () => executeBuildFdmGrid(),
      },
      text: `${validatedSupport.activeUnassignedCellCount.toLocaleString("en-US")} active magnetic cells have no semantic sub-region assigned.`,
      title: "Unassigned active voxels",
      tone: "warn",
    });
  }
  return list;
}

export interface MultilayerSliceRow {
  gridText: string;
  id: string;
  magnetName: string;
  objectId: string;
  transfer: string;
  zMinNm: number;
}

export function buildFdmGridBreadcrumbs(
  scope: FdmDomainSelectionScope,
  regionId: string | null,
): InspectorBreadcrumbItem[] {
  return [
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
    ...(scope === "domain" || scope === "descriptor"
      ? [{ id: "grid", label: "Structured Grid" }]
      : [
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
          {
            id: "subscope",
            label:
              scope === "universe-outside-support"
                ? "Airbox Outside-Support"
                : scope === "common"
                  ? "Common FFT Grid"
                  : scope === "region"
                    ? (regionId ?? "Region")
                    : scope,
          },
        ]),
  ];
}

export function buildFdmMultilayerStackRows(
  commonLayout: FdmMultilayerLayoutResource["common_transform_layout"] | null,
  mlLayers: readonly MultilayerSliceRow[],
  nFftSymbol: ReactNode,
): InspectorRowSpec<FdmGridDraft>[] {
  return [
    {
      format: () =>
        commonLayout
          ? `${commonLayout.shape.join(" × ")} (FFT scratch only — not a material carrier)`
          : "Not published",
      label: "Common convolution FFT grid",
      symbol: nFftSymbol,
      type: "readonly",
    },
    {
      format: (d) =>
        commonLayout?.cell_size
          ? fmtTuple3(commonLayout.cell_size, d.displayUnit)
          : "Not published",
      label: "Common cell size",
      showWhen: () => Boolean(commonLayout),
      type: "readonly",
    },
    {
      format: (d) =>
        commonLayout?.origin
          ? fmtCoord3(commonLayout.origin, d.displayUnit)
          : "Not published",
      label: "Common grid origin",
      showWhen: () => Boolean(commonLayout),
      type: "readonly",
    },
    {
      format: () =>
        commonLayout?.fft_shape
          ? commonLayout.fft_shape.join(" × ")
          : "Not published",
      label: "FFT transform shape",
      mono: true,
      showWhen: () => Boolean(commonLayout),
      type: "readonly",
    },
    {
      format: () =>
        commonLayout
          ? commonLayout.is_physical_mesh
            ? "Yes"
            : "No (FFT scratch layout)"
          : "Not published",
      label: "Physical mesh carrier",
      showWhen: () => Boolean(commonLayout),
      type: "readonly",
    },
    {
      copyText: () => commonLayout?.provenance ?? null,
      format: () => commonLayout?.provenance || "Not published",
      label: "Common grid provenance",
      mono: true,
      showWhen: () => Boolean(commonLayout),
      type: "readonly",
    },
    {
      columns: [
        {
          header: "Magnet layer",
          id: "name",
          renderCell: (r) => (r as MultilayerSliceRow).magnetName,
        },
        {
          header: "Native grid",
          id: "grid",
          mono: true,
          renderCell: (r) => (r as MultilayerSliceRow).gridText,
        },
        {
          align: "right",
          header: "Transfer",
          id: "transfer",
          mono: true,
          renderCell: (r) => (r as MultilayerSliceRow).transfer,
        },
      ],
      label: "Multilayer Z-stack slices",
      onSelectRow: (r, ctx) => {
        const row = r as MultilayerSliceRow;
        ctx.selectNode({
          kind: "mesh.grid.layer",
          label: row.magnetName,
          nodeId: `model:mesh:grid:layer:${encodeURIComponent(row.id)}`,
          objectId: row.objectId,
          ref: {
            kind: "mesh.grid.layer",
            layerId: row.id,
            nodeId: `model:mesh:grid:layer:${encodeURIComponent(row.id)}`,
            objectId: row.objectId,
            scope: "layer",
            type: "fdm-domain",
            visualizationTargetId: `fdm-native-layer:${encodeURIComponent(row.id)}`,
          },
        });
      },
      rowKey: (r) => (r as MultilayerSliceRow).id,
      rows: () => mlLayers,
      showWhen: () => mlLayers.length > 0,
      type: "table",
      wide: true,
    },
  ];
}

export function buildFdmGridProvenanceRows(
  domainMetaData: DomainMetaResource | null | undefined,
  membership: FdmRegionMembershipResource | null,
): InspectorRowSpec<FdmGridDraft>[] {
  return [
    {
      copyText: () => domainMetaData?.domain_id ?? null,
      format: () => domainMetaData?.domain_id ?? "Pending domain",
      label: "Domain ID",
      mono: true,
      type: "readonly",
    },
    {
      copyText: () => domainMetaData?.generation_id ?? null,
      format: () => domainMetaData?.generation_id ?? "Pending generation",
      label: "Domain generation ID",
      mono: true,
      type: "readonly",
    },
    {
      copyText: () => membership?.grid_fingerprint ?? null,
      format: () =>
        membership?.grid_fingerprint
          ? String(membership.grid_fingerprint)
          : "Pending materialization",
      label: "Grid fingerprint",
      mono: true,
      type: "readonly",
    },
    {
      format: () =>
        typeof membership?.mesh_revision === "number"
          ? String(membership.mesh_revision)
          : "Not materialized",
      label: "Mesh revision",
      mono: true,
      type: "readonly",
    },
    {
      format: () =>
        typeof membership?.region_membership_revision === "number"
          ? String(membership.region_membership_revision)
          : "Not materialized",
      label: "Membership revision",
      mono: true,
      type: "readonly",
    },
  ];
}
