"use client";

import { GitBranch, Radar } from "lucide-react";
import { useContext, useMemo } from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import {
  FmrOverviewInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainRunInspectorPanel,
} from "../../../panels/frequency-domain/FrequencyDomainResultInspectors";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  frequencyDomainRef,
  makeSimplePhysicsResultSpec,
  buildRefProvenanceRows,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
  type ReadOnlySpectralResultDraft,
} from "./resonanceShared";

export function ResultsOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const isFrequencyDomainRun =
    ref?.kind === "results.frequency_domain.run" ||
    Boolean(selection.nodeId?.includes("frequency-domain:run"));
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.root:${selection.nodeId ?? "root"}`,
        breadcrumbs: ["Results", "Overview"],
        title: selection.label || "Results",
        kindLabel: "Physics-first simulation outputs",
        facts: [
          { id: "families", label: "Families", value: "Dynamics · Resonance · Dispersion" },
          { id: "storage", label: "Format", value: "Zarr v3 & JSON manifests" },
        ],
        sectionTitle: isFrequencyDomainRun
          ? "Frequency-Domain Run & Result Families"
          : "Published Result Families",
        rows: [
          ...(kernel && isFrequencyDomainRun
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <FrequencyDomainRunInspectorPanel selection={selection} />,
                },
              ]
            : []),
          {
            type: "readonly",
            label: "Context node",
            mono: true,
            format: () => selection.nodeId ?? "—",
          },
          {
            type: "readonly",
            label: "Time-domain dynamics",
            format: () => "Observation frames, scalar tables, and FFT spectra",
          },
          {
            type: "readonly",
            label: "Linearized spectra",
            format: () => "Modal eigenfrequencies, driven FMR susceptibility, and k-resolved dispersion",
          },
          {
            type: "readonly",
            label: "Selection source",
            format: () => selection.moduleSource,
          },
          ...buildRefProvenanceRows(selection),
        ],
      }),
    [isFrequencyDomainRun, kernel, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export const ResultsRootTemplateInspectorPanel = ResultsOverviewInspectorPanel;

export function DynamicsResultTemplateInspector({ selection }: InspectorPanelProps) {
  const ref = frequencyDomainRef(selection);
  const isLegacySpectralFeature =
    ref?.kind === "results.time_domain.spectral_feature" || Boolean(ref?.pointId);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dynamics.root:${selection.nodeId ?? "dyn"}`,
        breadcrumbs: ["Results", "Dynamics"],
        title: selection.label || "Dynamics",
        kindLabel: isLegacySpectralFeature
          ? "Legacy time-domain spectral feature"
          : "Time-domain trajectories & observation frames",
        facts: [
          { id: "axis", label: "Primary axis", value: "Physical time t (s)" },
          { id: "handoff", label: "Spectral handoff", value: "Windowed FFT" },
          ...(typeof ref?.frequencyHz === "number"
            ? [{ id: "freq", label: "Frequency", value: formatFrequencyHz(ref.frequencyHz) }]
            : []),
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Time-domain observables & spectral handoff",
        rows: [
          ...(isLegacySpectralFeature
            ? [
                {
                  type: "readonly" as const,
                  label: "Selected item",
                  mono: true,
                  format: () => ref?.pointId ?? selection.nodeId ?? "—",
                },
                {
                  type: "readonly" as const,
                  label: "Sample",
                  mono: true,
                  format: () => ref?.sampleId ?? "—",
                },
                {
                  type: "readonly" as const,
                  label: "Frequency",
                  mono: true,
                  format: () =>
                    typeof ref?.frequencyHz === "number" && Number.isFinite(ref.frequencyHz)
                      ? `${ref.frequencyHz.toExponential(6)} Hz`
                      : "—",
                },
                {
                  type: "readonly" as const,
                  label: "Frequency bin",
                  mono: true,
                  format: () =>
                    ref?.frequencyIndex != null ? String(ref.frequencyIndex) : "—",
                },
                {
                  type: "readonly" as const,
                  label: "Source artifact",
                  mono: true,
                  format: () => ref?.artifactPath ?? "time-domain FFT",
                },
              ]
            : []),
          {
            type: "readonly",
            label: "Primary axis",
            format: () => "Time t; published SI/display unit is shown by the dataset",
          },
          {
            type: "readonly",
            label: "Published traces",
            format: () => "Magnetization <m>, energy terms, and max torque",
          },
          {
            type: "readonly",
            label: "Saved 3D states",
            format: () => "State snapshots appear when runtime publishes observation frames",
          },
          {
            type: "readonly",
            label: "Temporal Spectrum",
            format: () => "FFT of a published time trace; distinct from linearized eigenmodes",
          },
          {
            type: "readonly",
            label: "Spin-Wave Spectrum",
            format: () => "S(k, f) when wavevector-resolved samples are published",
          },
          ...buildRefProvenanceRows(selection),
        ],
      }),
    [isLegacySpectralFeature, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceOverviewResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const isCalcModes =
    ref?.kind === "results.frequency_domain.calculation_modes" ||
    Boolean(selection.nodeId?.includes("calculation-modes"));
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.root:${selection.nodeId ?? "res"}`,
        breadcrumbs: ["Results", "Resonance & FMR"],
        title: selection.label || "Resonance & FMR",
        kindLabel: "Uniform & confined k = 0 spectral products",
        facts: [
          { id: "modal", label: "Modal lane", value: "Eigenfrequencies & modes" },
          { id: "driven", label: "Driven lane", value: "Harmonic susceptibility chi(f)" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Resonance Product Overview & FMR Workbench",
        rows: [
          {
            type: "readonly",
            label: "Modal lane",
            format: () =>
              "Eigenfrequency Spectrum and complex Mode Shapes linearized about equilibrium",
          },
          {
            type: "readonly",
            label: "Driven lane",
            format: () =>
              "FMR Response Spectrum when RF magnetic drive & observable evidence are published",
          },
          {
            type: "readonly",
            label: "FMR naming gate",
            format: () => "Requires published RF excitation or modal coupling evidence",
          },
          {
            type: "readonly",
            label: "Comparison boundary",
            format: () =>
              "Matching equilibrium, geometry/mesh, k context, units, and observable definition",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      {isCalcModes ? (
                        <FrequencyDomainCalculationModesInspectorPanel selection={selection} />
                      ) : null}
                      <FrequencyDomainOverviewInspectorPanel selection={selection} />
                      <FmrOverviewInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [isCalcModes, kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function LegacyTimeDomainSpectralFeatureInspector({
  selection,
}: InspectorPanelProps) {
  const ref = frequencyDomainRef(selection);
  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `results.time_domain.spectral_feature:${selection.nodeId ?? "legacy"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "dyn", label: "Dynamics" },
          { id: "feat", label: selection.label || "Spectral Feature" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Radar,
        title: () => selection.label || ref?.pointId || "Time-Domain FFT Peak",
        kindLabel: "FFT spectral feature from time trajectory",
        statePill: () => ({ tone: "info", label: "FFT trace" }),
      },
      facts: () => [
        {
          id: "freq",
          label: "Frequency",
          value:
            typeof ref?.frequencyHz === "number"
              ? formatFrequencyHz(ref.frequencyHz)
              : "—",
        },
        {
          id: "bin",
          label: "FFT bin",
          value: ref?.frequencyIndex != null ? String(ref.frequencyIndex) : "—",
        },
      ],
      sections: [
        {
          id: "fft-detail",
          title: "Windowed FFT Peak",
          icon: GitBranch,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Selected item",
              mono: true,
              format: () => ref?.pointId ?? selection.nodeId ?? "—",
            },
            {
              type: "readonly",
              label: "Sample",
              mono: true,
              format: () => ref?.sampleId ?? "—",
            },
            {
              type: "readonly",
              label: "Source artifact",
              mono: true,
              format: () => ref?.artifactPath ?? "time-domain FFT",
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [ref, selection.label, selection.nodeId],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function LegacyTimeDomainDsfPointInspector({
  selection,
}: InspectorPanelProps) {
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.time_domain.dsf_point:${selection.nodeId ?? "dsf"}`,
        breadcrumbs: ["Results", "Dynamics", selection.label || "DSF Point"],
        title: selection.label || ref?.pointId || "Dynamical Structure Factor S(k, f)",
        kindLabel: "Time-domain spin-wave spectrum sample",
        facts: [
          {
            id: "freq",
            label: "Frequency",
            value:
              typeof ref?.frequencyHz === "number"
                ? formatFrequencyHz(ref.frequencyHz)
                : "—",
          },
          {
            id: "k",
            label: "Wavevector",
            value:
              typeof ref?.kPathCoordinateRadPerM === "number"
                ? `${(ref.kPathCoordinateRadPerM * 1e-6).toFixed(2)} rad/um`
                : "—",
          },
        ],
        sectionTitle: "DSF Sample Provenance",
        rows: [
          {
            type: "readonly",
            label: "Selected item",
            mono: true,
            format: () => ref?.pointId ?? selection.nodeId ?? "—",
          },
          {
            type: "readonly",
            label: "Sample",
            mono: true,
            format: () => ref?.sampleId ?? "—",
          },
          {
            type: "readonly",
            label: "Transform",
            format: () => "2D space-time FFT S(k, f) from sampled magnetization",
          },
        ],
      }),
    [ref, selection.label, selection.nodeId],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
