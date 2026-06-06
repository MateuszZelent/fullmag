import { InspectorSection } from "../../primitives/InspectorSection";
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
    <InspectorSection
      value="viewport-delivery"
      title="Viewport Delivery"
      badge={manifestStatus}
      collapsible
      defaultCollapsed={false}
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
    </InspectorSection>
  );
}
