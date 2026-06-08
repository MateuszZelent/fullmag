"use client";

import type { ChangeEvent } from "react";
import { Accordion } from "@/shared/ui/Accordion";
import { FormField } from "../../primitives/FormField";
import { InspectorSection } from "../../primitives/InspectorSection";
import { PhysicalScalarField } from "../ObjectRegionsPanel";
import {
  ObjectRegionMetadataSection,
  ObjectRegionActionsSection,
  ObjectRegionInlineDiagnostics,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionMeshPanel({
  model,
  draft,
  pending,
  canWriteRegion,
  couplingDependencies,
  updateMeshPolicy,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
}: RegionSubPanelProps) {
  const sections = ["regions", "mesh", "actions"];

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      <ObjectRegionMetadataSection model={model} />

      <InspectorSection value="mesh" title="Mesh Policy">
        <ObjectRegionInlineDiagnostics
          capabilityGates={["regions.mesh_policy"]}
          model={model}
        />
        <FormField
          label="Enable mesh policy"
          type="checkbox"
          checked={draft.meshPolicy.enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateMeshPolicy({ enabled: event.target.checked })}
        />
        <PhysicalScalarField
          label="Max element size"
          unit="m"
          value={draft.meshPolicy.maximumElementSize}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ maximumElementSize: next })}
        />
        <PhysicalScalarField
          label="Min element size"
          unit="m"
          value={draft.meshPolicy.minimumElementSize}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ minimumElementSize: next })}
        />
        <PhysicalScalarField
          label="Transition distance"
          unit="m"
          value={draft.meshPolicy.transitionDistance}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ transitionDistance: next })}
        />
        <FormField
          label="Order"
          type="number"
          step={1}
          value={String(draft.meshPolicy.order)}
          disabled={!draft.meshPolicy.enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateMeshPolicy({ order: Number(event.target.value) })}
        />
      </InspectorSection>

      <ObjectRegionActionsSection
        pending={pending}
        canWriteRegion={canWriteRegion}
        couplingDependencies={couplingDependencies}
        applyRegion={applyRegion}
        revert={revert}
        duplicateRegion={duplicateRegion}
        deleteRegion={deleteRegion}
        feedback={feedback}
      />
    </Accordion>
  );
}
