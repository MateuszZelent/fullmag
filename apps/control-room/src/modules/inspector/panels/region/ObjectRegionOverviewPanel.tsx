"use client";

import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { ChangeEvent } from "react";
import { Accordion } from "@/shared/ui/Accordion";
import { FormField } from "../../primitives/FormField";
import { InspectorSection } from "../../primitives/InspectorSection";
import type { RegionEditRealizationPolicy } from "../ObjectRegionsPanelModel";
import {
  ObjectRegionMetadataSection,
  ObjectRegionActionsSection,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionOverviewPanel({
  model,
  draft,
  pending,
  canWriteRegion,
  updateDraft,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
}: RegionSubPanelProps) {
  const sections = ["regions", "identity", "actions"];

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      <ObjectRegionMetadataSection model={model} />

      <InspectorSection value="identity" title="Region Identity">
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
      </InspectorSection>

      <ObjectRegionActionsSection
        pending={pending}
        canWriteRegion={canWriteRegion}
        applyRegion={applyRegion}
        revert={revert}
        duplicateRegion={duplicateRegion}
        deleteRegion={deleteRegion}
        feedback={feedback}
      />
    </Accordion>
  );
}
