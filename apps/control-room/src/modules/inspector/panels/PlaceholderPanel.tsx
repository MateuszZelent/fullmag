import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export function PlaceholderPanel({ selection }: InspectorPanelProps) {
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Selection">
        <FieldRow label="Label" value={selection.label ?? "Unnamed"} />
        <FieldRow label="Kind" value={selection.kind ?? "unknown"} />
        <FieldRow label="Node" value={selection.nodeId ?? "none"} />
      </InspectorGroup>
    </div>
  );
}
