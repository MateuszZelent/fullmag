"use client";

import { useEffect, useMemo } from "react";

import type { AnalyzeSelectionState, AnalyzeTab } from "./analyzeSelection";
import { useCurrentAnalyzeArtifacts } from "@/src/hooks/resources/useCurrentAnalyzeArtifacts";

interface AnalyzeWorkspaceController {
  analyzeSelection: AnalyzeSelectionState;
  setSelectedModeIndex: (index: number | null) => void;
  setTab: (tab: AnalyzeTab) => void;
}

export function useAnalyzeWorkspaceState(
  controller: AnalyzeWorkspaceController,
) {
  const { analyzeSelection, setSelectedModeIndex, setTab } = controller;
  const artifacts = useCurrentAnalyzeArtifacts(analyzeSelection.refreshNonce, {
    enabled: analyzeSelection.domain === "eigenmodes",
  });
  const selectedMode = analyzeSelection.selectedModeIndex;

  const selectedModeArtifact =
    selectedMode != null ? (artifacts.modeCache[selectedMode] ?? null) : null;

  const selectedModeSummary = useMemo(
    () =>
      artifacts.spectrum?.modes.find((mode) => mode.index === selectedMode) ?? null,
    [artifacts.spectrum, selectedMode],
  );

  useEffect(() => {
    if (!artifacts.spectrum || artifacts.spectrum.modes.length === 0) {
      return;
    }
    if (analyzeSelection.selectedModeIndex == null) {
      setSelectedModeIndex(artifacts.spectrum.modes[0].index);
    }
  }, [artifacts.spectrum, analyzeSelection.selectedModeIndex, setSelectedModeIndex]);

  useEffect(() => {
    if (selectedMode != null) {
      void artifacts.ensureMode(selectedMode, analyzeSelection.sampleIndex);
    }
  }, [artifacts, selectedMode, analyzeSelection.sampleIndex]);

  return {
    ...artifacts,
    selectedMode,
    selectedModeArtifact,
    selectedModeSummary,
    selectMode: setSelectedModeIndex,
    selectTab: setTab,
  };
}
