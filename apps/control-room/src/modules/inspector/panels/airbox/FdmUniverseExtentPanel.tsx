"use client";

import type { DomainMetaResource } from "@/kernel/api/apiTypes";
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

function roleSourceLabel(source: FdmUniverseExtentModel["universeRoleSource"]): string {
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
  model,
}: {
  model: FdmUniverseExtentModel;
}) {
  const kind = bannerKind(model.status);
  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-fdm-universe-status={model.status}
    >
      {kind ? <FeedbackBanner kind={kind} message={model.notice} /> : null}
      <InspectorGroup title="Structured FDM universe/grid extent" badge={model.status}>
        <FieldRow label="Discretization" value="FDM" />
        <FieldRow
          label="Magnetic-support / universe role"
          value={
            model.universeRole
              ? `Universe outside magnetic support (${roleSourceLabel(model.universeRoleSource)})`
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
        title="FEM shared-domain controls"
        badge="not applicable"
        description="FDM uses a structured grid. FEM element-size, grading, tetrahedral quality, and shared-domain build controls are intentionally unavailable."
      >
        <FieldRow label="Mesh policy" value="Not applicable to explicit FDM" />
        <FieldRow label="Build command" value="No FEM shared-domain build" />
        <FieldRow label="Quality / topology" value="Use published FDM grid resources" />
      </InspectorGroup>
    </div>
  );
}

export function FdmUniverseExtentPanel({
  resource,
  roleEvidence,
}: {
  resource: Pick<ResourceResult<DomainMetaResource | null>, "data" | "error" | "status">;
  roleEvidence?: FdmUniverseRoleEvidence | null;
}) {
  const model = resolveFdmUniverseExtentModel({
    explicitFdm: true,
    resource,
    roleEvidence,
  });
  return <FdmUniverseExtentPanelView model={model} />;
}
