import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

const MOCK_OBJECTS: Record<
  string,
  {
    dimensions: string;
    material: string;
    shape: string;
  }
> = {
  "free-layer": {
    dimensions: "120 x 60 x 4",
    material: "Permalloy",
    shape: "thin film",
  },
  "reference-layer": {
    dimensions: "120 x 60 x 3",
    material: "CoFeB",
    shape: "ellipse",
  },
};

export function GeometryObjectPanel({ selection }: InspectorPanelProps) {
  const objectId = selection.objectId ?? "";
  const object = MOCK_OBJECTS[objectId] ?? {
    dimensions: "unresolved",
    material: "unassigned",
    shape: selection.kind ?? "object",
  };

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Geometry Object">
        <FieldRow label="Name" value={selection.label ?? objectId} />
        <FieldRow label="Object ID" value={objectId || "none"} />
        <FieldRow label="Shape" value={object.shape} />
        <FieldRow label="Dimensions" unit="nm" value={object.dimensions} />
        <FieldRow label="Material" value={object.material} />
      </InspectorSection>
      <InspectorSection title="Resource State">
        <FieldRow label="Source" value="Explorer selection" />
        <FieldRow label="Mode" value="read-only scaffold" />
      </InspectorSection>
    </div>
  );
}
