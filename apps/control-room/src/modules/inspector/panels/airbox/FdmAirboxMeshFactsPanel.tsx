"use client";

import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  resolveFdmUniverseExtentModel,
  type FdmUniverseExtentResource,
  type FdmUniverseRoleEvidence,
} from "./fdmUniverseExtentModel";

export type FdmAirboxMeshFactsView =
  | "build"
  | "quality"
  | "statistics"
  | "topology";

function tuple(values: readonly number[] | null): string {
  return values ? `[${values.join(", ")}]` : "not available";
}

function count(value: number | null | undefined): string {
  return value == null ? "not materialized" : value.toLocaleString("en-US");
}

export function FdmAirboxMeshFactsPanel({
  membership,
  resource,
  roleEvidence,
  view,
}: {
  membership: FdmRegionMembershipResource | null;
  resource: FdmUniverseExtentResource;
  roleEvidence: FdmUniverseRoleEvidence | null;
  view: FdmAirboxMeshFactsView;
}) {
  const model = resolveFdmUniverseExtentModel({
    explicitFdm: true,
    resource,
    roleEvidence,
  });
  const support = membership?.magnetic_support;
  const warning = model.status === "ready" ? null : model.notice;

  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-fdm-airbox-mesh-view={view}
    >
      {warning ? <FeedbackBanner kind="warning" message={warning} /> : null}
      {view === "quality" ? (
        <InspectorGroup title="FDM Airbox quality" badge="structured-grid checks">
          <FieldRow
            label="Descriptor completeness"
            value={model.status === "error" ? "failed" : "available"}
          />
          <FieldRow
            label="Membership freshness"
            value={membership?.freshness ?? "not materialized"}
          />
          <FieldRow label="FEM element quality" value="not applicable" />
        </InspectorGroup>
      ) : null}
      {view === "statistics" ? (
        <InspectorGroup title="FDM Airbox statistics" badge="published facts">
          <FieldRow label="Total cells" value={count(model.totalCells)} />
          <FieldRow label="Airbox cells" value={count(support?.inactive_cell_count)} />
          <FieldRow label="Magnetic cells" value={count(support?.active_cell_count)} />
          <FieldRow
            label="Owner / region entries"
            value={count(membership?.region_legend.length)}
          />
        </InspectorGroup>
      ) : null}
      {view === "topology" ? (
        <InspectorGroup title="FDM Airbox topology" badge="implicit">
          <FieldRow label="Explicit element topology" value="not applicable" />
          <FieldRow
            label="Structured-grid shape"
            value={model.gridShape?.join(" × ") ?? "not available"}
          />
          <FieldRow label="Cell spacing" value={tuple(model.spacing)} unit={model.units.length} />
        </InspectorGroup>
      ) : null}
      {view === "build" ? (
        <InspectorGroup title="FDM Airbox provenance" badge="read-only">
          <FieldRow label="Generation" value={model.generationId ?? "not materialized"} mono />
          <FieldRow
            label="Grid fingerprint"
            value={membership?.grid_fingerprint ?? "not materialized"}
            mono
          />
          <FieldRow
            label="Membership revision"
            value={count(membership?.region_membership_revision)}
          />
          <FieldRow label="Standalone mesh build" value="not applicable" />
        </InspectorGroup>
      ) : null}
    </div>
  );
}
