"use client";

import { useEffect, useMemo } from "react";

import type { AnalyzeSelectionState, AnalyzeTab } from "./analyzeSelection";
import {
  buildModeKey,
  normalizeSpectrumArtifact,
} from "@/components/analyze/eigenTypes";
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
  const selectedSampleIndex = analyzeSelection.sampleIndex ?? 0;
  const normalizedSpectrum = useMemo(
    () => normalizeSpectrumArtifact(artifacts.spectrum),
    [artifacts.spectrum],
  );

  const selectedModeArtifact =
    selectedMode != null
      ? (artifacts.modeCache[buildModeKey(selectedSampleIndex, selectedMode)]
          ?? artifacts.modeCache[buildModeKey(0, selectedMode)]
          ?? null)
      : null;

  const selectedModeSummary = useMemo(
    () =>
      normalizedSpectrum?.samples
        .find((sample) => sample.sample_index === selectedSampleIndex)
        ?.modes.find((mode) => mode.raw_mode_index === selectedMode) ?? null,
    [normalizedSpectrum, selectedMode, selectedSampleIndex],
  );

  useEffect(() => {
    const firstSample = normalizedSpectrum?.samples[0];
    if (!firstSample || firstSample.modes.length === 0) {
      return;
    }
    if (analyzeSelection.selectedModeIndex == null) {
      setSelectedModeIndex(firstSample.modes[0].raw_mode_index);
    }
  }, [normalizedSpectrum, analyzeSelection.selectedModeIndex, setSelectedModeIndex]);

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
