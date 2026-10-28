import type { ReactNode } from "react";

import { useInspectorActiveTab } from "../../InspectorTabState";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { physicsFirstResultInspectorModel } from "./physicsFirstResultInspectorModel";

interface PhysicsFirstResultInspectorFrameProps {
  children?: ReactNode;
  contentTabs?: readonly string[];
  selection: InspectorPanelProps["selection"];
}

/** A collection has no single artifact; resource metadata belongs in its own tab. */
export function PhysicsFirstResultInspectorFrame({
  children,
  contentTabs = ["overview"],
  selection,
}: PhysicsFirstResultInspectorFrameProps) {
  const activeTab = useInspectorActiveTab();
  const model = physicsFirstResultInspectorModel(selection.kind ?? "");
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const collection = selection.kind?.endsWith(".root") ?? false;
  if (!model) return <InspectorGroup title="Unsupported result"><FieldRow label="Reason" value="No inspector owns this result type." /></InspectorGroup>;
  const diagnostics = [
    ...(ref?.contractGap ? [ref.contractGap] : []),
    ...(!collection && !ref ? ["Result identity is missing; visualization and comparison are disabled."] : []),
    ...(ref?.availability === "unsupported" ? ["This operation is not supported for the selected result."] : []),
    ...(ref?.availability === "unavailable" && !collection ? ["The selected result is unavailable. Check its published artifacts."] : []),
  ];
  return (
    <div className="fm-result-inspector" data-result-tab={activeTab}>
      {diagnostics.length > 0 ? <div role="status" className="fm-result-inspector__notice">{diagnostics.join(" ")}</div> : null}
      {activeTab === "overview" && collection ? <p className="fm-result-inspector__help">Select a published study below this collection to inspect its chart or fields.</p> : null}
      {activeTab === "data" ? <InspectorGroup title="Result context">
        {ref?.studyProduct ? <FieldRow label="Product" value={ref.studyProduct.replaceAll("_", " ")} /> : null}
        {ref?.kContextKind ? <FieldRow label="Wavevector sampling" value={ref.kContextKind.replaceAll("_", " ")} /> : null}
        <FieldRow label="Result" value={model.description} />
      </InspectorGroup> : null}
      {activeTab === "provenance" ? <InspectorGroup title="Artifact provenance">
        <FieldRow label="Run" mono value={ref?.analysisRunId ?? "Owner identity not published"} />
        {!collection ? <>
          <FieldRow label="Stage" mono value={ref?.analysisStageId ?? "Stage identity not published"} />
          <FieldRow label="Equilibrium" mono value={ref?.equilibriumId ?? "Equilibrium identity not published"} />
          <FieldRow label="Artifact revision" mono value={ref?.artifactRevision ?? "Revision not published"} />
          {ref?.normalization ? <FieldRow label="Normalization" value={ref.normalization} /> : null}
          {ref?.resourceRef ? <FieldRow label="Resource" mono value={ref.resourceRef} /> : null}
        </> : null}
      </InspectorGroup> : null}
      {activeTab === "diagnostics" ? <InspectorGroup title="Resource diagnostics">
        <FieldRow label="Resource" value={ref?.resourceState ?? "Not loaded"} />
        <FieldRow label="Execution" value={ref?.executionState ?? "Not reported"} />
        <FieldRow label="Availability" value={ref?.availability ?? "Not reported"} />
        <p className="fm-result-inspector__help">Resource readiness does not certify convergence or completeness of the spectrum.</p>
      </InspectorGroup> : null}
      {contentTabs.includes(activeTab) ? children : null}
    </div>
  );
}
