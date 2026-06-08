"use client";

import { Accordion } from "@/shared/ui/Accordion";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionNestedRegionsPanel({ model }: RegionSubPanelProps) {
  const sections = ["regions", "nested"];

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      <ObjectRegionMetadataSection model={model} />

      <InspectorSection value="nested" title="Nested Regions Limitation" collapsible={false}>
        <FeedbackBanner
          kind="warning"
          message="Nested regions are not supported in v1. This region still inherits its parent object; create another flat region on the same parent object instead."
        />
        <div style={{ marginTop: "12px" }}>
          <FieldRow label="Inheritance" value="parent object" />
          <FieldRow label="Authoring mode" value="flat regions only" />
          <FieldRow label="Runtime lowering" value="not available for child regions" />
        </div>
      </InspectorSection>
    </Accordion>
  );
}
