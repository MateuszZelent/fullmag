/**
 * Analyze feature – public API barrel.
 */
export { useAnalyzeStore } from "./store/useAnalyzeStore";
export { useAnalyzeSelection, useAnalyzeQuery, useAnalyzeQueryKey } from "./queries/useAnalyzeQueries";
export { fetchAnalyzeArtifact, abortAllAnalyzeRequests } from "./api/analyzeApi";
export type {
  AnalyzeSelectionState,
  AnalyzeTab,
  AnalyzeDomain,
  AnalyzeQueryKey,
  AnalyzeQueryState,
  AnalyzeQueryStatus,
  EigenSpectrumResult,
  EigenModeResult,
  VortexTimeTraceResult,
  VortexFrequencyResult,
  VortexOrbitResult,
} from "./model/analyzeTypes";

// Results workspace model
export {
  EMPTY_RESULTS_WORKSPACE,
  findResultNode,
  allResultNodes,
} from "./model/resultsWorkspace";
export type {
  ResultNodeKind,
  ResultNode,
  DatasetNode,
  PlotGroupNode,
  TableNode,
  AnalysisWorkspaceNode,
  ExportNode,
  ReportNode,
  AnalysisKind,
  PlotEntry,
  PlotDisplayState,
  TableColumnEntry,
  ReportSectionEntry,
  ResultsWorkspaceState,
} from "./model/resultsWorkspace";

// Results commands
export { applyResultsCommand } from "./commands/resultsCommands";
export type { ResultsCommand } from "./commands/resultsCommands";

// Results node context
export {
  parseResultNodeContext,
  isResultNodeId,
  resultContextToNodeKind,
} from "./model/resultNodeContext";
export type { ResultNodeContext } from "./model/resultNodeContext";

// Results template registry
export {
  registerResultTemplate,
  getResultTemplate,
  getAllResultTemplates,
  getResultTemplatesByCategory,
  resultLabel,
  resultIconToken,
} from "./registry/resultsTemplateRegistry";
export type { ResultTemplateEntry, ResultTemplateCategory } from "./registry/resultsTemplateRegistry";

// Results authoring UI
export { ResultsAuthoringShell } from "./views/ResultsAuthoringShell";
export type { ResultsAuthoringShellProps } from "./views/ResultsAuthoringShell";
