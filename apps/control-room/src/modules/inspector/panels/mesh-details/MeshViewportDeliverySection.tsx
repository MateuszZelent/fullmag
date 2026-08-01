import { InspectorGroup } from "../../primitives/InspectorGroup";
import { MeshResourceFields } from "../MeshResourceView";

export function MeshViewportDeliverySection({
  manifestStatus,
  meshGenerationId,
  meshRevision,
}: {
  manifestStatus: string;
  meshGenerationId: string | null | undefined;
  meshRevision: unknown;
}) {
  return (
    <InspectorGroup
      title="Viewport Delivery"
      badge={manifestStatus}
      collapsible
      defaultOpen
    >
      <MeshResourceFields
        fields={[
          {
            label: "Backend mesh revision",
            value: String(meshRevision ?? "unknown"),
          },
          {
            label: "Generation",
            value: meshGenerationId ?? "not published",
          },
          {
            label: "Viewport acknowledgement",
            value: "tracked in Mesh Jobs",
          },
        ]}
      />
    </InspectorGroup>
  );
}
