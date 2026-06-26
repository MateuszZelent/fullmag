import { useObjectTopologicalChargeResource } from "@/kernel/resources/studyRuntimeResources";
import { FeedbackBanner } from "@/modules/inspector/primitives/FeedbackBanner";
import { FieldRow } from "@/modules/inspector/primitives/FieldRow";
import { InspectorSection } from "@/modules/inspector/primitives/InspectorSection";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { resolveTopologicalChargePanelModel } from "./topologicalChargeModel";

export function TopologicalChargeExtensionPanel({ selection }: InspectorPanelProps) {
  const objectId =
    selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const resource = useObjectTopologicalChargeResource(objectId);
  const model = resolveTopologicalChargePanelModel(resource.status, resource.data);

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Topological Charge">
        {model.banner ? (
          <FeedbackBanner kind={model.banner.kind} message={model.banner.message} />
        ) : null}
        {model.rows.map((row) => (
          <FieldRow key={row.label} label={row.label} value={row.value} />
        ))}
      </InspectorSection>
    </div>
  );
}
