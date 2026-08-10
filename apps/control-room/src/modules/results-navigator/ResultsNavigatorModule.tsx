"use client";

import { useCallback, useMemo } from "react";

import {
  useCurrentRunResource,
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenFieldSweepResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainFmrKittelFitResource,
  useFrequencyDomainFmrPeaksResource,
  useFrequencyDomainFmrResonanceFitsResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseDiagnosticsResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";

import { ResultsNavigatorTree } from "./ResultsNavigatorTree";
import {
  buildFrequencyDomainResultsTree,
  mapNavigatorArtifactState,
  mapResourceResultState,
} from "./resultsNavigatorModel";
import {
  navigatorArtifactFromResource,
  navigatorBranchesFromResource,
  navigatorFmrFromResource,
  navigatorKittelFitArtifactFromResource,
  navigatorManifestFromResource,
  navigatorProgressFromResource,
  navigatorResonanceFitsArtifactFromResource,
  navigatorResponseFromResource,
  navigatorSpectrumFromResource,
  type FrequencyDomainNavigatorInput,
  type NavigatorIdentity,
  type ResultsNavigatorNode,
} from "./resultsNavigatorTypes";
import {
  kernelSelectionForResultsNavigatorNode,
} from "./resultsNavigatorSelection";

function activeStageId(
  activeStageIndex: number | null | undefined,
  stages: readonly { index: number; stage_id: string }[] | undefined,
): string | null {
  if (activeStageIndex == null || !stages) return null;
  return stages.find((stage) => stage.index === activeStageIndex)?.stage_id ?? null;
}

function resolveIdentity({
  currentRun,
  manifestRevision,
  stageExecution,
}: {
  currentRun: ReturnType<typeof useCurrentRunResource>["data"];
  manifestRevision: string | number | null;
  stageExecution: ReturnType<typeof useStageExecutionResource>["data"];
}): NavigatorIdentity | null {
  if (!currentRun || !stageExecution) return null;
  const stageId = activeStageId(
    currentRun.active_stage_index ?? stageExecution.active_stage_index,
    stageExecution.stages,
  );
  if (!stageId) return null;
  return {
    artifactRevision: String(manifestRevision ?? currentRun.revision),
    runId: currentRun.run_id,
    stageId,
  };
}

export default function ResultsNavigatorModule({
  kernel,
  moduleId,
}: ModuleProps) {
  const currentRun = useCurrentRunResource();
  const stageExecution = useStageExecutionResource();
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const fieldSweep = useFrequencyDomainEigenFieldSweepResource();
  const fmrPeaks = useFrequencyDomainFmrPeaksResource();
  const fmrResonanceFits = useFrequencyDomainFmrResonanceFitsResource();
  const fmrKittelFit = useFrequencyDomainFmrKittelFitResource();
  const response = useFrequencyDomainResponseSweepResource();
  const responseProgress = useFrequencyDomainResponseProgressResource();
  const responseDiagnostics = useFrequencyDomainResponseDiagnosticsResource();
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);

  const identity = useMemo(
    () =>
      resolveIdentity({
        currentRun: currentRun.data,
        manifestRevision: manifest.revision,
        stageExecution: stageExecution.data,
      }),
    [currentRun.data, manifest.revision, stageExecution.data],
  );
  const input = useMemo<FrequencyDomainNavigatorInput>(
    () => {
      const typedSpectrum = navigatorSpectrumFromResource(spectrum.data);
      const typedBranches = navigatorBranchesFromResource(branches.data);
      const typedResponse = navigatorResponseFromResource(response.data);
      const typedFmr = navigatorFmrFromResource(fmrPeaks.data);
      const resonanceFitsArtifact =
        navigatorResonanceFitsArtifactFromResource(fmrResonanceFits.data);
      const kittelFitArtifact =
        navigatorKittelFitArtifactFromResource(fmrKittelFit.data);
      const resonanceFitsTransportState =
        mapResourceResultState(fmrResonanceFits);
      const kittelFitTransportState = mapResourceResultState(fmrKittelFit);
      return {
        branches: typedBranches,
        identity,
        manifest: navigatorManifestFromResource(manifest.data),
        manifestState: manifest.data
          ? undefined
          : manifest.status === "loading"
            ? "loading"
            : manifest.status === "error"
              ? "error"
              : "missing",
        progress: navigatorProgressFromResource(responseProgress.data),
        progressState: responseProgress.data
          ? undefined
          : responseProgress.status === "loading"
            ? "loading"
            : responseProgress.status === "error"
              ? "error"
              : "missing",
        resources: {
          branches: navigatorArtifactFromResource(branches.data),
          dispersion: navigatorArtifactFromResource(dispersion.data),
          fieldSweep: navigatorArtifactFromResource(fieldSweep.data),
          response: navigatorArtifactFromResource(response.data),
          responseDiagnostics: navigatorArtifactFromResource(responseDiagnostics.data),
          resultManifest: navigatorArtifactFromResource(manifest.data?.result_manifest),
          spectrum: navigatorArtifactFromResource(spectrum.data),
          states: {
            branches: mapResourceResultState(branches),
            dispersion: mapResourceResultState(dispersion),
            fieldSweep: mapResourceResultState(fieldSweep),
            response: mapResourceResultState(response),
            responseDiagnostics: mapResourceResultState(responseDiagnostics),
            resultManifest: manifest.data?.result_manifest
              ? mapNavigatorArtifactState(
                  navigatorArtifactFromResource(manifest.data.result_manifest),
                )
              : "missing",
            spectrum: mapResourceResultState(spectrum),
          },
        },
        fmr: {
          kittelFit: kittelFitArtifact,
          peaks: navigatorArtifactFromResource(fmrPeaks.data),
          resonanceFits: resonanceFitsArtifact,
          states: {
            kittelFit:
              kittelFitTransportState === "ready"
                ? mapNavigatorArtifactState(kittelFitArtifact)
                : kittelFitTransportState,
            peaks: mapResourceResultState(fmrPeaks),
            resonanceFits:
              resonanceFitsTransportState === "ready"
                ? mapNavigatorArtifactState(resonanceFitsArtifact)
                : resonanceFitsTransportState,
          },
          ...(typedFmr ? { payload: typedFmr } : {}),
        },
        response: typedResponse,
        spectrum: typedSpectrum,
      } satisfies FrequencyDomainNavigatorInput;
    },
    [
      branches,
      dispersion,
      fieldSweep,
      fmrKittelFit,
      fmrPeaks,
      fmrResonanceFits,
      identity,
      manifest.data,
      manifest.status,
      response,
      responseDiagnostics,
      responseProgress.data,
      responseProgress.status,
      spectrum,
    ],
  );
  const nodes = useMemo(() => buildFrequencyDomainResultsTree(input), [input]);
  const onSelect = useCallback(
    (node: ResultsNavigatorNode) => {
      const { kind, ref } = kernelSelectionForResultsNavigatorNode(node);
      kernel.selection.set(
        {
          kind,
          label: node.label,
          nodeId: node.id,
          objectId: null,
          ref,
        },
        moduleId,
      );
    },
    [kernel.selection, moduleId],
  );

  return (
    <section aria-label="Results" className="fm-results-navigator">
      <header className="fm-results-navigator__header">
        <h2>Results</h2>
        <span data-status={nodes[0]?.status ?? "missing"}>
          {nodes[0]?.status ?? "missing"}
        </span>
      </header>
      <ResultsNavigatorTree
        nodes={nodes}
        onSelect={onSelect}
        selectedNodeId={selectedNodeId}
      />
    </section>
  );
}
