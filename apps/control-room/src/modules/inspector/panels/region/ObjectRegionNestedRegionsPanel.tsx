"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionNestedRegionsPanel({ model }: RegionSubPanelProps) {
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} />

      <InspectorGroup title="Nested Regions Limitation">
        <FeedbackBanner
          kind="warning"
          message="Nested regions are not supported in v1. This region still inherits its parent object; create another flat region on the same parent object instead."
        />
        <div className="fm-mt-3">
          <FieldRow label="Inheritance" value="parent object" />
          <FieldRow label="Authoring mode" value="flat regions only" />
          <FieldRow label="Runtime lowering" value="not available for child regions" />
        </div>
      </InspectorGroup>
    </div>
  );
}
