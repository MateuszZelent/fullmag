"use client";

import {
  FileOutput,
  Layers,
  Sigma,
  Table2,
} from "lucide-react";
import { useMemo } from "react";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  analysisViewInspectorModel,
  derivedValueInspectorModel,
  exportInspectorModel,
  tableInspectorModel,
} from "../../../panels/physics-first/postprocessingInspectorModel";
import {
  PostprocessingModelInspectorView,
  scopeForPostprocessingSelection,
} from "./playbackShared";

export function AnalysisViewsOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => analysisViewInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Pin a mode visualization or save an analysis plot configuration to reuse it across runs."
      emptyTitle="No analysis views saved yet"
      icon={Layers}
      idPrefix="results.analysis_views.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function AnalysisViewDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => analysisViewInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={Layers}
      idPrefix="results.analysis_views.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function DerivedValuesOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => derivedValueInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Derived scalars (coercivity, linewidth, Q-factor, topological charge) appear here once evaluated."
      emptyTitle="No derived scalar values defined yet"
      icon={Sigma}
      idPrefix="results.derived_values.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function DerivedValueDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => derivedValueInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={Sigma}
      idPrefix="results.derived_values.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function TablesOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => tableInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Enable Table Autosave before a Run stage or execute a sweep stage to record tabular observables."
      emptyTitle="No scalar tables published yet"
      icon={Table2}
      idPrefix="results.tables.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function TableDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => tableInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={Table2}
      idPrefix="results.tables.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function ExportsOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => exportInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Export a field state, table CSV, or Zarr bundle to list downloadable artifacts here."
      emptyTitle="No exported archives yet"
      hostFrequencyDomainExports
      icon={FileOutput}
      idPrefix="results.exports.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function ExportDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => exportInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={FileOutput}
      idPrefix="results.exports.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}
