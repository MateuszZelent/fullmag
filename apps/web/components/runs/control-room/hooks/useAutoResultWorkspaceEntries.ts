import { useEffect, useMemo } from "react";
import type { ArtifactEntry } from "@/lib/session/types";
import type { ViewportMode } from "../shared";
import type { AnalyzeSelectionState } from "../analyzeSelection";
import type {
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
} from "../context-hooks";

export function useAutoResultWorkspaceEntries(opts: {
  activeResultWorkspaceId: string | null;
  addResultWorkspaceEntry: (entry: {
    key?: string | null;
    kind: ResultWorkspaceKind;
    label: string;
    quantityId?: string | null;
    icon?: string;
    badge?: string | null;
    pinned?: boolean;
    openAfterCreate?: boolean;
  }) => string;
  analyzeSelection: AnalyzeSelectionState;
  artifacts: ArtifactEntry[];
  requestedPreviewQuantity: string;
  resultWorkspaceEntries: ResultWorkspaceEntry[];
  selectedQuantityLabel: string;
  selectedQuantityUnit: string | null;
  setActiveResultWorkspaceId: (id: string) => void;
  viewMode: ViewportMode;
}) {
  const {
    activeResultWorkspaceId,
    addResultWorkspaceEntry,
    analyzeSelection,
    artifacts,
    requestedPreviewQuantity,
    resultWorkspaceEntries,
    selectedQuantityLabel,
    selectedQuantityUnit,
    setActiveResultWorkspaceId,
    viewMode,
  } = opts;

  const activeQuantityEntryId = useMemo(() => {
    if (!requestedPreviewQuantity) {
      return null;
    }
    return (
      resultWorkspaceEntries.find(
        (entry) => entry.kind === "quantity" && entry.quantityId === requestedPreviewQuantity,
      )?.id ?? null
    );
  }, [requestedPreviewQuantity, resultWorkspaceEntries]);

  useEffect(() => {
    if (!requestedPreviewQuantity) {
      return;
    }
    addResultWorkspaceEntry({
      key: `auto:quantity:${requestedPreviewQuantity}`,
      kind: "quantity",
      label: selectedQuantityLabel,
      quantityId: requestedPreviewQuantity,
      badge: selectedQuantityUnit ?? null,
      openAfterCreate: false,
    });
  }, [
    addResultWorkspaceEntry,
    requestedPreviewQuantity,
    selectedQuantityLabel,
    selectedQuantityUnit,
  ]);

  useEffect(() => {
    if (!requestedPreviewQuantity || activeResultWorkspaceId != null) {
      return;
    }
    if (activeQuantityEntryId && activeResultWorkspaceId !== activeQuantityEntryId) {
      setActiveResultWorkspaceId(activeQuantityEntryId);
    }
  }, [
    activeQuantityEntryId,
    activeResultWorkspaceId,
    requestedPreviewQuantity,
    setActiveResultWorkspaceId,
  ]);

  useEffect(() => {
    const hasSpectrumArtifact = artifacts.some(
      (artifact) =>
        artifact.path === "eigen/spectrum.json" ||
        artifact.path === "eigen/metadata/eigen_summary.json",
    );
    if (!hasSpectrumArtifact) {
      return;
    }
    addResultWorkspaceEntry({
      key: "auto:eigen:spectrum",
      kind: "spectrum",
      label: "Eigen Spectrum",
      badge: "auto",
      openAfterCreate: false,
    });
  }, [addResultWorkspaceEntry, artifacts]);

  useEffect(() => {
    if (viewMode !== "Analyze") {
      return;
    }
    const descriptor =
      analyzeSelection.domain === "vortex"
        ? (analyzeSelection.tab === "time-traces"
            ? { key: "auto:vortex:time-traces", kind: "time-traces", label: "Vortex Time Traces" }
            : analyzeSelection.tab === "vortex-frequency"
              ? { key: "auto:vortex:frequency", kind: "vortex-frequency", label: "Vortex FFT / PSD" }
              : analyzeSelection.tab === "vortex-orbit"
                ? { key: "auto:vortex:orbit", kind: "vortex-orbit", label: "Vortex Orbit Amplitude" }
                : { key: "auto:vortex:trajectory", kind: "vortex-trajectory", label: "Vortex Trajectory" })
        : (analyzeSelection.tab === "dispersion"
            ? { key: "auto:eigen:dispersion", kind: "dispersion", label: "Eigen Dispersion" }
            : analyzeSelection.tab === "modes"
              ? { key: "auto:eigen:modes", kind: "modes", label: "Mode Inspector" }
              : { key: "auto:eigen:spectrum", kind: "spectrum", label: "Eigen Spectrum" });
    const id = addResultWorkspaceEntry({
      key: descriptor.key,
      kind: descriptor.kind as ResultWorkspaceKind,
      label: descriptor.label,
      openAfterCreate: false,
    });
    if (activeResultWorkspaceId !== id) {
      setActiveResultWorkspaceId(id);
    }
  }, [
    activeResultWorkspaceId,
    addResultWorkspaceEntry,
    analyzeSelection.domain,
    analyzeSelection.tab,
    setActiveResultWorkspaceId,
    viewMode,
  ]);
}
