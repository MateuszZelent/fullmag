"use client";

import { useMemo } from "react";

import {
  useDomainMetaResource,
  useFdmRegionMembershipResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  resolveFdmGridInspectorModel,
  type FdmGridInspectorModel,
} from "./fdmGridInspectorModel";

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

export function FdmGridInspectorPanelView({
  model,
}: {
  model: FdmGridInspectorModel;
}) {
  const bannerKind = statusBannerKind(model.status);

  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-fdm-grid-status={model.status}
    >
      {bannerKind && model.notice ? (
        <FeedbackBanner kind={bannerKind} message={model.notice} />
      ) : null}

      <InspectorGroup title="Structured Grid" badge={model.statusLabel}>
        <FieldRow label="Domain" value={model.domainId ?? "not available"} mono />
        <FieldRow label="Generation" value={model.generationId ?? "not available"} mono />
        <FieldRow label="Shape" value={formatShape(model.shape)} />
        <FieldRow
          label="Origin"
          value={formatTuple(model.origin)}
          unit={model.units.length}
        />
        <FieldRow
          label="Spacing"
          value={formatTuple(model.spacing)}
          unit={model.units.length}
        />
        <FieldRow label="Total cells" value={formatCount(model.totalCells)} />
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
          value={
            model.cellClassification === "unknown"
              ? "Unknown until the membership resource is available"
              : "Not applicable"
          }
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
  void selection;
  const sessionDiscretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
  );
  const explicitFdm = sessionDiscretization?.toLowerCase() === "fdm";
  const domain = useDomainMetaResource({ enabled: true });
  const membership = useFdmRegionMembershipResource({ enabled: explicitFdm });
  const model = useMemo(
    () => resolveFdmGridInspectorModel({ domain, membership }),
    [domain, membership],
  );

  return <FdmGridInspectorPanelView model={model} />;
}
