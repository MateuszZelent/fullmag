"use client";

import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { ChangeEvent } from "react";
import { FormField } from "../../primitives/FormField";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { RegionEditRealizationPolicy } from "../ObjectRegionsPanelModel";
import type { MeshInspectorLane } from "../fdmMeshInspectorModel";
import {
  ObjectRegionMetadataSection,
  ObjectRegionActionsSection,
  ObjectRegionInlineDiagnostics,
  type RegionSubPanelProps,
} from "./shared";

export interface ObjectRegionOverviewLaneView {
  inlineDiagnostics: boolean;
  realization: MeshInspectorLane;
}

export function resolveObjectRegionOverviewLaneView(
  meshLane: MeshInspectorLane = "unknown",
): ObjectRegionOverviewLaneView {
  if (meshLane === "fem") {
    return { inlineDiagnostics: true, realization: "fem" };
  }
  if (meshLane === "fdm") {
    return { inlineDiagnostics: false, realization: "fdm" };
  }
  return { inlineDiagnostics: false, realization: "unknown" };
}

export function ObjectRegionOverviewPanel({
  model,
  draft,
  pending,
  draftDirty,
  buildRegion,
  regionMeshLifecycle,
  canWriteRegion,
  canWriteMeshRegion,
  meshLane = "unknown",
  couplingDependencies,
  updateDraft,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
}: RegionSubPanelProps) {
  const laneView = resolveObjectRegionOverviewLaneView(meshLane);

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} meshLane={meshLane} />

      <InspectorGroup title="Region Identity">
        {laneView.inlineDiagnostics ? (
          <ObjectRegionInlineDiagnostics
            capabilityGates={[
              "regions.realized_materialization",
              "regions.conformal_or_projected_boundary",
            ]}
            model={model}
          />
        ) : null}
        <FormField
          label="Region name"
          mono={false}
          type="text"
          value={draft.name}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateDraft({ name: event.target.value })}
        />
        <FormField
          label="Enabled"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateDraft({ enabled: event.target.checked })}
        />
        <FormField
          label="Priority"
          type="number"
          step={1}
          value={String(draft.priority)}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateDraft({ priority: Number(event.target.value) })}
        />
        <FormField
          label="Frame"
          type="select"
          value={draft.frame}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => updateDraft({ frame: event.target.value as components["schemas"]["SceneRegionFrame"] })}
        >
          <option value="object">Object</option>
          <option value="world">World</option>
        </FormField>
        {laneView.realization === "fem" ? (
          <FormField
            label="Realization"
            type="select"
            value={draft.realizationPolicy}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              updateDraft({
                realizationPolicy: event.target.value as RegionEditRealizationPolicy,
              })
            }
          >
            <option value="inherit">Inherit</option>
            <option value="conformal">Conformal</option>
            <option value="project">Project</option>
          </FormField>
        ) : (
          <FieldRow
            label="Realization"
            value={
              laneView.realization === "fdm"
                ? "Runtime-derived structured-grid membership"
                : "Withheld until the session discretization is explicit"
            }
          />
        )}
      </InspectorGroup>

      <ObjectRegionActionsSection
        pending={pending}
        draftDirty={draftDirty}
        buildRegion={buildRegion}
        regionMeshLifecycle={regionMeshLifecycle}
        canWriteRegion={canWriteRegion}
        canWriteMeshRegion={canWriteMeshRegion}
        meshLane={meshLane}
        couplingDependencies={couplingDependencies}
        applyRegion={applyRegion}
        revert={revert}
        duplicateRegion={duplicateRegion}
        deleteRegion={deleteRegion}
        feedback={feedback}
      />
    </div>
  );
}
