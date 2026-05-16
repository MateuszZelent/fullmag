import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

export function PlaceholderPanel({ selection }: InspectorPanelProps) {
  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Selection">
        <FieldRow label="Label" value={selection.label ?? "Unnamed"} />
        <FieldRow label="Kind" value={selection.kind ?? "unknown"} />
        <FieldRow label="Node" value={selection.nodeId ?? "none"} />
      </InspectorSection>
    </div>
  );
}
