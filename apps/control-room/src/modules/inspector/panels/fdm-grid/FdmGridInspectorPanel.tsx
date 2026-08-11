"use client";

import { useCallback, useMemo, type ReactNode } from "react";

import {
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useFdmRegionMembershipBinaryResource,
  useFdmRegionMembershipResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
  resolveTargetVisualization,
  type VisualizationTargetPatch,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { resolveFdmDisplaySampling } from "@/shared/domain/mesh/fdmDisplaySampling";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { ObjectVisualizationPanel } from "../ObjectVisualizationPanel";
import {
  NumberField,
  VisualizationToggleButton,
} from "../ObjectVisualizationTargetSection";
import {
  resolveFdmGridInspectorModel,
  resolveFdmGridSelectionInspectorModel,
  type FdmGridInspectorModel,
  type FdmGridSelectionCell,
  type FdmGridSelectionInspectorModel,
} from "./fdmGridInspectorModel";
import {
  resolveFdmMultilayerInspectorModel,
  type FdmMultilayerInspectorModel,
} from "./fdmMultilayerInspectorModel";

function formatTuple(values: readonly number[] | null): string {
  return values ? `[${values.join(", ")}]` : "not available";
}

function formatCount(value: number | null): string {
  return value == null ? "not available" : value.toLocaleString("en-US");
}

function formatShape(values: readonly number[] | null): string {
  return values ? values.join(" × ") : "not available";
}

function statusBannerKind(
  status: FdmGridInspectorModel["status"],
): "error" | "warning" | null {
  if (status === "error") return "error";
  if (status === "loading" || status === "stale" || status === "not-materialized") {
    return "warning";
  }
  return null;
}

function FdmUniverseDisplayControls({
  disabled,
  onPatch,
  settings,
}: {
  disabled: boolean;
  onPatch: (patch: VisualizationTargetPatch) => void;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorGroup
      title="Airbox · Visualization"
      badge="structured grid"
      description="Controls apply to the FDM Airbox extent and its magnetic-support bounds. The mesh remains one regular structured grid."
    >
      <div className="fm-viz-layer-strip" role="group" aria-label="FDM universe display layers">
        <VisualizationToggleButton
          active={settings.visible}
          disabled={disabled}
          label="Visible"
          onClick={() => onPatch({ visible: !settings.visible })}
        />
        <VisualizationToggleButton
          active={settings.boundsVisible}
          disabled={disabled || !settings.visible}
          label="Bounds"
          onClick={() => onPatch({ boundsVisible: !settings.boundsVisible })}
        />
        <VisualizationToggleButton
          active={settings.wireframeVisible}
          disabled={disabled || !settings.visible}
          label="Grid wireframe"
          onClick={() => onPatch({ wireframeVisible: !settings.wireframeVisible })}
        />
      </div>
      {settings.boundsVisible ? (
        <NumberField
          disabled={disabled || !settings.visible}
          label="Universe/support bounds opacity"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.boundsOpacityPercent}
          onChange={(value) => onPatch({ boundsOpacityPercent: value })}
        />
      ) : null}
      {settings.wireframeVisible ? (
        <NumberField
          disabled={disabled || !settings.visible}
          label="Grid wireframe opacity"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.wireframeOpacityPercent}
          onChange={(value) => onPatch({ wireframeOpacityPercent: value })}
        />
      ) : null}
    </InspectorGroup>
  );
}

function FdmMultilayerInspectorPanelView({
  model,
  visualizationControls,
}: {
  model: FdmMultilayerInspectorModel;
  visualizationControls?: ReactNode;
}) {
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" data-fdm-multilayer-status={model.status}>
      {model.notice ? (
        <FeedbackBanner
          kind="warning"
          message={model.notice}
        />
      ) : null}
      <InspectorGroup title={model.title} badge={model.status}>
        {model.rows.length ? model.rows.map((row) => (
          <FieldRow key={row.label} label={row.label} value={row.value} mono={row.mono} />
        )) : <FieldRow label="State" value="not published" />}
      </InspectorGroup>
      {visualizationControls}
    </div>
  );
}

export function FdmGridInspectorPanelView({
  detail,
  displaySettings,
  model,
  multilayer,
  multilayerVisualizationControls,
  onDisplayPatch,
}: {
  detail: FdmGridSelectionInspectorModel;
  displaySettings?: VisualizationTargetSettings | null;
  model: FdmGridInspectorModel;
  multilayer?: FdmMultilayerInspectorModel | null;
  multilayerVisualizationControls?: ReactNode;
  onDisplayPatch?: (patch: VisualizationTargetPatch) => void;
}) {
  if (multilayer) {
    return (
      <FdmMultilayerInspectorPanelView
        model={multilayer}
        visualizationControls={multilayerVisualizationControls}
      />
    );
  }
  const bannerKind = statusBannerKind(model.status);
  const displaySampling =
    model.totalCells == null ? null : resolveFdmDisplaySampling(model.totalCells);
  const displayedCell = detail.cell ?? detail.snapshotCell;
  const cellTitle = detail.cell ? "Current Cell" : "Selected Cell Snapshot";
  const classification = detail.cell
    ? `Verified from current mask: ${detail.cell.maskState}`
    : detail.snapshotCell
      ? "Withheld because the selected snapshot is stale"
      : model.membership
        ? "Select a cell to inspect its canonical classification"
        : model.cellClassification === "unknown"
          ? "Unknown until the membership resource is available"
          : "Not applicable";

  const cellRows = (cell: FdmGridSelectionCell) => (
    <>
      <FieldRow label="Cell ordinal" value={cell.cellOrdinal} mono />
      <FieldRow label="Cell IJK" value={formatTuple(cell.ijk)} />
      <FieldRow label="Mask state" value={cell.maskState} />
      <FieldRow
        label="Numeric region"
        value={cell.numericRegionId == null ? "none" : String(cell.numericRegionId)}
      />
      <FieldRow label="Semantic region" value={cell.regionId ?? "none"} mono />
      <FieldRow label="Grid fingerprint" value={cell.gridFingerprint} mono />
      <FieldRow label="Membership revision" value={cell.membershipRevision} mono />
    </>
  );

  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-fdm-grid-status={model.status}
      data-fdm-selection-status={detail.status}
    >
      {bannerKind && model.notice ? (
        <FeedbackBanner kind={bannerKind} message={model.notice} />
      ) : null}

      {detail.notice ? (
        <FeedbackBanner
          kind="warning"
          message={detail.notice}
        />
      ) : null}

      {detail.scope === "universe-outside-support" &&
      displaySettings &&
      onDisplayPatch ? (
        <FdmUniverseDisplayControls
          disabled={model.status !== "ready"}
          onPatch={onDisplayPatch}
          settings={displaySettings}
        />
      ) : null}

      <InspectorGroup title={detail.title} badge={detail.status}>
        <FieldRow label="Scope" value={detail.scope} mono />
        {detail.region ? (
          <>
            <FieldRow label="Region" value={detail.region.regionId} mono />
            <FieldRow label="Numeric region" value={String(detail.region.numericId)} />
            <FieldRow label="Object" value={detail.region.objectId} mono />
            <FieldRow label="Priority" value={String(detail.region.priority)} />
          </>
        ) : null}
        {detail.support ? (
          <>
            <FieldRow
              label="Support bounds min"
              value={formatTuple(detail.support.boundsMin)}
              unit={model.units.length}
            />
            <FieldRow
              label="Support bounds max"
              value={formatTuple(detail.support.boundsMax)}
              unit={model.units.length}
            />
            <FieldRow
              label="Active cells"
              value={formatCount(detail.support.activeCellCount)}
            />
            <FieldRow
              label="Active unassigned cells"
              value={formatCount(detail.support.activeUnassignedCellCount)}
            />
            <FieldRow
              label="Inactive cells"
              value={formatCount(detail.support.inactiveCellCount)}
            />
          </>
        ) : null}
      </InspectorGroup>

      {displayedCell ? (
        <InspectorGroup title={cellTitle} badge={detail.status}>
          {cellRows(displayedCell)}
        </InspectorGroup>
      ) : null}

      {detail.scope === "universe-outside-support" ? (
        <InspectorGroup
          title="Magnetic support owners and regions"
          badge={model.membership ? `${model.membership.legend.length}` : "not materialized"}
          description="Every realized ferromagnetic owner and region stays explicit in the membership legend."
        >
          {model.membership?.legend.length ? (
            <ul className="m-0 grid list-none gap-1 p-0 text-fm-xs text-fm-muted">
              {model.membership.legend.map((entry) => (
                <li key={`${entry.numericId}:${entry.objectId}:${entry.regionId}`}>
                  Owner: {entry.objectId} · Region: {entry.regionId} · numeric {entry.numericId} · priority {entry.priority}
                </li>
              ))}
            </ul>
          ) : (
            <FieldRow label="Contributors" value="not materialized" />
          )}
        </InspectorGroup>
      ) : null}

      <InspectorGroup title="Structured Grid" badge={model.statusLabel}>
        <FieldRow label="Domain" value={model.domainId ?? "not available"} mono />
        <FieldRow label="Generation" value={model.generationId ?? "not available"} mono />
        <FieldRow label="Shape" value={formatShape(model.shape)} />
        <FieldRow label="Origin [m]" value={formatTuple(model.origin)} />
        <FieldRow label="Cell spacing [m]" value={formatTuple(model.spacing)} />
        <FieldRow label="cells" value={formatCount(model.totalCells)} />
        <FieldRow
          label="Display samples"
          value={displaySampling ? formatCount(displaySampling.displaySamples) : "not available"}
        />
        <FieldRow
          label="Display stride"
          value={displaySampling ? formatCount(displaySampling.stride) : "not available"}
        />
        <FieldRow
          label="Display budget"
          value={displaySampling ? formatCount(displaySampling.budget) : "not available"}
        />
        <FieldRow
          label="Length unit"
          value={model.units.length ?? "not published"}
        />
      </InspectorGroup>

      <InspectorGroup
        title="Cell Membership"
        badge={model.membership ? model.membership.freshness : "not materialized"}
        description="Cell classification is never inferred without a canonical FDM membership resource."
      >
        <FieldRow
          label="Classification"
          value={classification}
        />
        {model.membership ? (
          <>
            <FieldRow label="Freshness" value={model.membership.freshness} />
            <FieldRow label="Encoding" value={model.membership.encoding} mono />
            <FieldRow
              label="Mesh revision"
              value={String(model.membership.meshRevision)}
            />
            <FieldRow
              label="Membership revision"
              value={String(model.membership.regionMembershipRevision)}
            />
            <FieldRow
              label="Grid fingerprint"
              value={model.membership.gridFingerprint}
              mono
            />
            <FieldRow
              label="Legend"
              value={`${model.membership.legend.length.toLocaleString("en-US")} entries`}
            />
            {model.membership.legend.length > 0 ? (
              <ul className="m-0 grid list-none gap-1 p-0 text-fm-xs text-fm-muted">
                {model.membership.legend.map((entry) => (
                  <li key={`${entry.numericId}:${entry.regionId}`}>
                    {entry.regionId} · numeric {entry.numericId} · {entry.objectId}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </InspectorGroup>
    </div>
  );
}

export function FdmGridInspectorPanel({ selection }: InspectorPanelProps) {
  const sessionDiscretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
  );
  const explicitFdm = sessionDiscretization?.toLowerCase() === "fdm";
  const domain = useDomainMetaResource({ enabled: true });
  const membership = useFdmRegionMembershipResource({ enabled: explicitFdm });
  const membershipRevision = membership.data
    ? `${membership.data.mesh_revision}:${membership.data.region_membership_revision}`
    : null;
  const binary = useFdmRegionMembershipBinaryResource(null, {
    enabled: explicitFdm && selection.ref?.type === "fdm-cell",
    revision: membershipRevision,
  });
  const model = useMemo(
    () => resolveFdmGridInspectorModel({ domain, membership }),
    [domain, membership],
  );
  const multilayerLayout = useFdmMultilayerLayoutResource({ enabled: explicitFdm });
  const multilayer = useMemo(
    () => resolveFdmMultilayerInspectorModel(multilayerLayout.data, selection),
    [multilayerLayout.data, selection],
  );
  const detail = useMemo(
    () =>
      resolveFdmGridSelectionInspectorModel({
        base: model,
        binary,
        membership,
        selection,
      }),
    [binary, membership, model, selection],
  );

  const visualization = useObjectVisualizationController();
  const visualizationSnapshot = useObjectVisualizationSelector(
    (snapshot) => snapshot,
  );
  const outsideSupportSelected =
    selection.ref?.type === "fdm-domain" &&
    selection.ref.scope === "universe-outside-support";
  const displaySettings = useMemo(
    () =>
      outsideSupportSelected
        ? resolveTargetVisualization({
            snapshot: visualizationSnapshot,
            target: FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
          }).settings
        : null,
    [outsideSupportSelected, visualizationSnapshot],
  );
  const onDisplayPatch = useCallback(
    (patch: VisualizationTargetPatch) => {
      if (!outsideSupportSelected) return;
      visualization.patchTarget(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET, patch);
    },
    [outsideSupportSelected, visualization],
  );
  const nativeLayerSelected =
    selection.ref?.type === "fdm-domain" &&
    selection.ref.visualizationTargetId.startsWith("fdm-native-layer:");

  return (
    <FdmGridInspectorPanelView
      detail={detail}
      displaySettings={displaySettings}
      model={model}
      multilayer={multilayer}
      multilayerVisualizationControls={
        nativeLayerSelected ? <ObjectVisualizationPanel selection={selection} /> : null
      }
      onDisplayPatch={onDisplayPatch}
    />
  );
}
