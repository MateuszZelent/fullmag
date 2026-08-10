import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { MeshEditorCapabilityModel } from "@/shared/domain/mesh/meshEditorCapabilityModel";

const LABELS = {
  fdm: "FDM structured mesh",
  fem: "FEM mesh",
  cpu: "CPU",
  gpu: "CUDA GPU",
  single: "Single precision",
  double: "Double precision",
  multilayer: "Multilayer",
  pbc: "Periodic boundaries",
} as const;

function statusLabel(enabled: boolean, status: string): string {
  if (enabled) return status === "supported" ? "available" : status;
  return status === "unavailable" ? "unavailable" : "blocked";
}

export function MeshEditorCapabilitiesSection({
  model,
}: {
  model: MeshEditorCapabilityModel;
}) {
  const enabledCount = model.options.filter((option) => option.enabled).length;
  return (
    <InspectorGroup
      title="Mesh editor capabilities"
      badge={`${enabledCount}/${model.options.length} available`}
    >
      {model.options.map((option) => (
        <FieldRow
          key={option.id}
          label={LABELS[option.id]}
          value={
            <span title={option.reason ?? undefined}>
              {statusLabel(option.enabled, option.status)}
              {option.reason ? ` — ${option.reason}` : ""}
            </span>
          }
        />
      ))}
    </InspectorGroup>
  );
}
