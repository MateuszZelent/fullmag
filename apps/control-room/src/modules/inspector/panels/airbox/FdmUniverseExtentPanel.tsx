"use client";

import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  resolveFdmUniverseExtentModel,
  type FdmUniverseRoleEvidence,
  type FdmUniverseExtentModel,
} from "./fdmUniverseExtentModel";

function formatTuple(values: readonly number[] | null): string {
  return values ? `[${values.join(", ")}]` : "not available";
}

function formatShape(values: readonly number[] | null): string {
  return values ? values.join(" × ") : "not available";
}

function formatCount(value: number | null): string {
  return value == null ? "not available" : value.toLocaleString("en-US");
}

function roleSourceLabel(model: FdmUniverseExtentModel): string {
  if (model.universeRole?.reason === "authored-universe-exceeds-magnetic-support") {
    return "authored scene";
  }
  const source = model.universeRoleSource;
  if (source === "domain-presentation") return "domain presentation";
  if (source === "explicit-role-resource") return "explicit role resource";
  return "published";
}

function bannerKind(
  status: FdmUniverseExtentModel["status"],
): "error" | "warning" | null {
  if (status === "error") return "error";
  if (status === "loading" || status === "stale" || status === "not-materialized") {
    return "warning";
  }
  return null;
}

export function FdmUniverseExtentPanelView({
  membership,
  model,
}: {
  membership?: FdmRegionMembershipResource | null;
  model: FdmUniverseExtentModel;
}) {
  const kind = bannerKind(model.status);
  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-fdm-universe-status={model.status}
    >
      {kind ? <FeedbackBanner kind={kind} message={model.notice} /> : null}
      <InspectorGroup title="Airbox · FDM structured universe" badge={model.status}>
        <FieldRow label="Discretization" value="FDM" />
        <FieldRow
          label="Airbox role"
          value={
            model.universeRole
              ? `Airbox outside magnetic support (${roleSourceLabel(model)})`
              : "not published"
          }
        />
        <FieldRow label="Domain" value={model.domainId ?? "not available"} mono />
        <FieldRow label="Generation" value={model.generationId ?? "not available"} mono />
        <FieldRow label="Coordinate system" value={model.coordinateSystem ?? "not published"} />
        <FieldRow label="Grid shape" value={formatShape(model.gridShape)} />
        <FieldRow label="Total cells" value={formatCount(model.totalCells)} />
        <FieldRow label="Origin" value={formatTuple(model.origin)} unit={model.units.length} />
        <FieldRow label="Cell spacing" value={formatTuple(model.spacing)} unit={model.units.length} />
        <FieldRow label="Bounds min" value={formatTuple(model.boundsMin)} unit={model.units.length} />
        <FieldRow label="Bounds max" value={formatTuple(model.boundsMax)} unit={model.units.length} />
      </InspectorGroup>
      <InspectorGroup
        title="Airbox execution artifact"
        badge="read-only"
        description={
          membership
            ? "The current FDM grid and membership mask are published by the execution plan. Re-run or re-plan the study to obtain a new extent."
            : "The FDM grid descriptor is available from authoring, but the membership mask is not materialized. Re-plan or run the study to publish it."
        }
      >
        <FieldRow label="Grid lifecycle" value="Published structured-grid artifact" />
        <FieldRow
          label="Membership mask"
          value={membership ? "Published with the grid" : "Not materialized"}
        />
        <FieldRow label="Standalone refresh" value="Unavailable for the current plan" />
      </InspectorGroup>
      <InspectorGroup
        title="Magnetic support owners and regions"
        badge={membership?.region_legend.length ? `${membership.region_legend.length}` : "not materialized"}
        description="Multiple ferromagnetic objects and their regions remain explicit in the FDM membership legend."
      >
        {membership?.region_legend.length ? (
          <ul className="m-0 grid list-none gap-1 p-0 text-fm-xs text-fm-muted">
            {membership.region_legend.map((entry) => (
              <li key={`${entry.numeric_id}:${entry.object_id}:${entry.region_id}`}>
                Owner: {entry.object_id} · Region: {entry.region_id} · numeric {entry.numeric_id} · priority {entry.priority}
              </li>
            ))}
          </ul>
        ) : (
          <FieldRow label="Contributors" value="not materialized" />
        )}
      </InspectorGroup>
    </div>
  );
}

export function FdmUniverseExtentPanel({
  membership,
  resource,
  roleEvidence,
}: {
  membership?: FdmRegionMembershipResource | null;
  resource: Pick<ResourceResult<DomainMetaResource | null>, "data" | "error" | "status">;
  roleEvidence?: FdmUniverseRoleEvidence | null;
}) {
  const model = resolveFdmUniverseExtentModel({
    explicitFdm: true,
    resource,
    roleEvidence,
  });
  return <FdmUniverseExtentPanelView membership={membership} model={model} />;
}
