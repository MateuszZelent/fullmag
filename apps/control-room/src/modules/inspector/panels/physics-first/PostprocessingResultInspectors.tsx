import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  analysisViewInspectorModel,
  derivedValueInspectorModel,
  exportInspectorModel,
  tableInspectorModel,
  type PostprocessingInspectorModel,
} from "./postprocessingInspectorModel";

function scopeForSelection(
  selection: InspectorPanelProps["selection"],
): "definition" | "root" {
  return selection.ref?.type === "postprocessing"
    ? selection.ref.scope
    : selection.kind?.endsWith(".root")
      ? "root"
      : "definition";
}

function renderModel(model: PostprocessingInspectorModel) {
  return (
    <ScientificInspectorTemplate
      actions={(
        <InspectorGroup title="Legal actions">
          <FieldRow label="Policy" value={model.actionLabel} />
        </InspectorGroup>
      )}
      breadcrumbs={model.breadcrumbs}
      diagnostics={model.diagnostics}
      methodLabel={model.methodLabel}
      physicalLabel={model.physicalLabel}
      properties={model.properties}
      provenance={model.provenance}
      status={model.status}
      title={model.title}
    />
  );
}

export function AnalysisViewsOverviewInspector({ selection }: InspectorPanelProps) {
  return renderModel(analysisViewInspectorModel(selection, "root"));
}

export function AnalysisViewDefinitionInspector({ selection }: InspectorPanelProps) {
  return renderModel(analysisViewInspectorModel(selection, scopeForSelection(selection)));
}

export function DerivedValuesOverviewInspector({ selection }: InspectorPanelProps) {
  return renderModel(derivedValueInspectorModel(selection, "root"));
}

export function DerivedValueDefinitionInspector({ selection }: InspectorPanelProps) {
  return renderModel(derivedValueInspectorModel(selection, scopeForSelection(selection)));
}

export function TablesOverviewInspector({ selection }: InspectorPanelProps) {
  return renderModel(tableInspectorModel(selection, "root"));
}

export function TableDefinitionInspector({ selection }: InspectorPanelProps) {
  return renderModel(tableInspectorModel(selection, scopeForSelection(selection)));
}

export function ExportsOverviewInspector({ selection }: InspectorPanelProps) {
  return renderModel(exportInspectorModel(selection, "root"));
}

export function ExportDefinitionInspector({ selection }: InspectorPanelProps) {
  return renderModel(exportInspectorModel(selection, scopeForSelection(selection)));
}
