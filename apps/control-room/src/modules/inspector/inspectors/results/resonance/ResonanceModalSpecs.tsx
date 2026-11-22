"use client";

import {
  Box,
  Download,
  Pin,
  Play,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import { PIN_MODE_VISUALIZATION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { minMaxFinite } from "@/shared/charts/ScientificEChart";
import { buildEigenSpectrumChartModel, eigenModeFieldAvailable } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { ReferenceImportSection } from "../../../panels/analysis-results/ReferenceImportSection";
import { EigenModeInspectorPanel } from "../../../panels/frequency-domain/EigenModeInspectorPanel";
import { FmrModalSpectrumInspectorPanel } from "../../../panels/frequency-domain/FmrModalSpectrumInspectorPanel";
import {
  EigenDiagnosticsInspectorPanel,
  EigenModeFieldResourceInspectorPanel,
  EigenModesInspectorPanel,
  EigenModesVisualizationInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
} from "../../../panels/frequency-domain/FrequencyDomainResultInspectors";
import { FrequencyDomainSpectrumChart } from "../../../panels/FrequencyDomainCharts";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  frequencyDomainRef,
  makeSimplePhysicsResultSpec,
  buildRefProvenanceRows,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
  copyCsvText,
  ModeHarmonicPhaseControls,
  type ReadOnlySpectralResultDraft,
} from "./resonanceShared";

export function ResonanceModalStageResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceModalStageResultInspector {...props} />
  ) : (
    <ResonanceModalStageResultView {...props} hasManifest={false} />
  );
}

function ConnectedResonanceModalStageResultInspector(props: InspectorPanelProps) {
  const manifest = useFrequencyDomainManifestResource();
  return (
    <ResonanceModalStageResultView
      {...props}
      hasManifest={Boolean(manifest.data?.result_manifest?.payload)}
    />
  );
}

function ResonanceModalStageResultView({
  hasManifest,
  selection,
}: InspectorPanelProps & { hasManifest: boolean }) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const rev = hasManifest ? "Verified" : "Ready";
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.stage:${selection.nodeId ?? "stage"}`,
        breadcrumbs: ["Results", "Resonance & FMR", selection.label || "Modal Stage"],
        title: selection.label || "Modal Eigenmodes Stage Result",
        kindLabel: "Linearized modal stage provenance",
        stateLabel: rev,
        facts: [
          { id: "lane", label: "Lane", value: "Modal eigenmodes (k = 0)" },
          { id: "manifest", label: "Manifest", value: rev },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Equilibrium, Study Contract & Operator Provenance",
        rows: [
          {
            type: "readonly",
            label: "Operator",
            format: () => "Linearized LLG tangent-plane operator",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <EigenStudyInspectorPanel selection={selection} />
                      <EigenOverviewInspectorPanel selection={selection} />
                      <EigenProvenanceInspectorPanel
                        canonicalFamily="FMR modal lane · k = 0"
                        linksTitle="FMR Modal Provenance Links"
                        selection={selection}
                        title="FMR Modal Provenance"
                      />
                      <EigenDiagnosticsInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, rev, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceModalSpectrumResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceModalSpectrumResultInspector {...props} />
  ) : (
    <ResonanceModalSpectrumResultView {...props} spectrumData={null} />
  );
}

function ConnectedResonanceModalSpectrumResultInspector(props: InspectorPanelProps) {
  const spectrumRes = useFrequencyDomainEigenSpectrumResource();
  return (
    <ResonanceModalSpectrumResultView
      {...props}
      spectrumData={spectrumRes.data ?? null}
    />
  );
}

function ResonanceModalSpectrumResultView({
  selection,
  spectrumData,
}: InspectorPanelProps & { spectrumData: Parameters<typeof buildEigenSpectrumChartModel>[0] }) {
  const kernel = useContext(KernelContext);
  const model = useMemo(
    () => buildEigenSpectrumChartModel(spectrumData),
    [spectrumData],
  );
  const bounds = useMemo(
    () => minMaxFinite(model.points.map((p) => p.frequencyHz)),
    [model.points],
  );

  const exportSpectrumCsv = useCallback(() => {
    const header =
      "sample_index,raw_mode_index,frequency_hz,imaginary_frequency_hz,damping_rate_hz,residual_norm,mode_field_id";
    const rows = model.points.map((pt) =>
      [
        pt.sampleIndex,
        pt.rawModeIndex,
        pt.frequencyHz,
        pt.imaginaryFrequencyHz ?? "",
        pt.dampingRateHz ?? "",
        pt.residualNorm ?? "",
        pt.modeFieldId ?? "",
      ].join(","),
    );
    copyCsvText([header, ...rows].join("\n"));
  }, [model.points]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.spectrum:${selection.nodeId ?? "spec"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Eigenfrequency Spectrum"],
        title: selection.label || "Eigenfrequency Spectrum",
        kindLabel: "Modal eigenfrequencies & damping linewidths",
        extraMenuActions: [
          {
            id: "export-spectrum-csv",
            label: "Export Spectrum CSV",
            icon: Download,
            disabledReason:
              model.points.length === 0 ? "No solved eigenmodes to export" : undefined,
            onSelect: () => exportSpectrumCsv(),
          },
        ],
        facts: [
          { id: "count", label: "Modes", value: String(model.points.length) },
          {
            id: "span",
            label: "Frequency span",
            value: bounds
              ? `${formatFrequencyHz(bounds.min)} – ${formatFrequencyHz(bounds.max)}`
              : "—",
          },
        ],
        sectionTitle: "Modal Spectrum Workbench",
        rows: [
          {
            type: "readonly",
            label: "Computed eigenmodes",
            format: () => `${model.points.length} modes ranked by Re(f)`,
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={model.points.length === 0}
                          disabledReason="No solved eigenmodes to export"
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={exportSpectrumCsv}
                        >
                          <Download aria-hidden="true" size={13} />
                          <span>Export Spectrum CSV</span>
                        </Button>
                      </div>
                      <EigenSpectrumInspectorPanel selection={selection} />
                      <FmrModalSpectrumInspectorPanel selection={selection} />
                      <ReferenceImportSection />
                    </div>
                  ),
                },
              ]
            : model.points.length > 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Eigenfrequency spectrum",
                    wide: true,
                    render: () => <FrequencyDomainSpectrumChart model={model} />,
                  },
                ]
              : []),
        ],
      }),
    [bounds, exportSpectrumCsv, kernel, model, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceModeShapesResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.modes:${selection.nodeId ?? "modes"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Mode Shapes"],
        title: selection.label || "Spatial Mode Shapes",
        kindLabel: "Complex eigenvector catalog",
        commitMode: "liveViewport",
        onResetDisplay: () => {
          if (!kernel) return;
          void kernel.commands.execute(
            "analysis.frequency-domain.stop-3d-animation",
            createCommandContext("inspector", kernel),
          );
          kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
        },
        facts: [{ id: "encoding", label: "Encoding", value: "Complex tangent vector" }],
        sectionTitle: "3D Mode Profiles & Eigenmode Browser",
        rows: [
          {
            type: "custom",
            label: "Harmonic phase preview",
            wide: true,
            render: () => <ModeHarmonicPhaseControls />,
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <EigenModesInspectorPanel selection={selection} />
                      <EigenModesVisualizationInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [kernel, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ModalModeResultInspectorShared(props: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedModalModeResultInspectorShared {...props} />;
  }
  return <ModalModeResultInspectorView {...props} resolvedFieldId={frequencyDomainRef(props.selection)?.fieldId ?? null} />;
}

function ConnectedModalModeResultInspectorShared(props: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  selection: Selection;
}) {
  const ref = frequencyDomainRef(props.selection);
  const sampleIndex = ref?.sampleIndex ?? null;
  const modeIndex = ref?.modeIndex ?? null;
  const fieldMeta = useFrequencyDomainEigenModeFieldMetaResource(sampleIndex, modeIndex);
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const resolvedFieldId = useMemo(() => {
    if (ref?.fieldId) return ref.fieldId;
    if (fieldMeta.data?.field_id) return fieldMeta.data.field_id;
    const pts = buildEigenSpectrumChartModel(spectrum.data).points;
    const matched = pts.find(
      (pt) => pt.sampleIndex === sampleIndex && pt.rawModeIndex === modeIndex,
    );
    return matched && eigenModeFieldAvailable(matched) ? matched.modeFieldId ?? null : null;
  }, [fieldMeta.data?.field_id, modeIndex, ref?.fieldId, sampleIndex, spectrum.data]);

  return <ModalModeResultInspectorView {...props} resolvedFieldId={resolvedFieldId} />;
}

function ModalModeResultInspectorView({
  breadcrumbsPrefix,
  defaultTitle,
  idPrefix,
  kindLabel,
  onPhaseChangeDeg,
  resolvedFieldId,
  selection,
}: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  resolvedFieldId: string | null;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const fieldId = resolvedFieldId;
  const isModeFieldResource = ref?.kind === "results.eigen.mode_field";

  const activateModeIn3D = useCallback(async () => {
    if (!kernel || !fieldId) return;
    await kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, { sourceDetail: idPrefix }),
      {
        fieldId,
        label: selection.label || defaultTitle,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  }, [defaultTitle, fieldId, idPrefix, kernel, selection.label]);

  const pinModeVisualization = useCallback(() => {
    if (!kernel || !fieldId) return;
    void kernel.commands.execute(
      PIN_MODE_VISUALIZATION_COMMAND,
      createCommandContext("inspector", kernel, { sourceDetail: idPrefix }),
    );
  }, [fieldId, idPrefix, kernel]);

  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `${idPrefix}:${selection.nodeId ?? "mode"}`,
      header: {
        breadcrumbs: [
          { id: "b0", label: breadcrumbsPrefix[0] },
          { id: "b1", label: breadcrumbsPrefix[1] },
          { id: "mode", label: selection.label || defaultTitle },
        ],
        ...(kernel
          ? {
              ...(fieldId
                ? {
                    primaryHeaderAction: {
                      label: "Load in 3D",
                      icon: Box,
                      onRun: activateModeIn3D,
                    },
                  }
                : {}),
              extraMenuActions: [
                {
                  id: "pin-mode-viz",
                  label: "Pin Mode Visualization",
                  icon: Pin,
                  disabledReason: !fieldId
                    ? "Mode field payload is required to pin a 3D visualization"
                    : undefined,
                  onSelect: () => pinModeVisualization(),
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Sparkles,
        title: () =>
          selection.label ||
          (ref?.modeIndex != null ? `Eigenmode #${ref.modeIndex + 1}` : defaultTitle),
        kindLabel,
        entityId: fieldId ?? ref?.modeId ?? undefined,
        statePill: () => ({
          tone: fieldId ? "ok" : "neutral",
          label: fieldId ? "3D field ready" : "Selected",
        }),
      },
      facts: () => [
        {
          id: "freq",
          label: "Frequency",
          value:
            typeof ref?.frequencyHz === "number"
              ? formatFrequencyHz(ref.frequencyHz)
              : "Published",
        },
        {
          id: "mode-idx",
          label: "Mode index",
          value: ref?.modeIndex != null ? String(ref.modeIndex + 1) : "1",
        },
        ...(ref?.sampleIndex != null
          ? [{ id: "sample", label: "Sample", value: String(ref.sampleIndex) }]
          : []),
      ],
      sections: [
        {
          id: "phase-animation",
          title: "3D Mode Shape Animation & Controls",
          icon: Play,
          defaultOpen: true,
          live: true,
          rows: [
            {
              type: "custom",
              label: "GPU harmonic phase rotation",
              wide: true,
              render: () => (
                <ModeHarmonicPhaseControls onPhaseChangeDeg={onPhaseChangeDeg} />
              ),
            },
            ...(kernel
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid min-w-0 gap-3">
                        {isModeFieldResource ? (
                          <EigenModeFieldResourceInspectorPanel selection={selection} />
                        ) : null}
                        <EigenModeInspectorPanel selection={selection} />
                      </div>
                    ),
                  },
                ]
              : []),
            ...buildRefProvenanceRows(selection),
          ],
        },
      ],
      commitBar: {
        mode: "liveViewport",
        hasOverrides: () => false,
        onResetDisplay: () => {
          if (!kernel) return;
          void kernel.commands.execute(
            "analysis.frequency-domain.stop-3d-animation",
            createCommandContext("inspector", kernel),
          );
          kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
        },
      },
    }),
    [
      activateModeIn3D,
      breadcrumbsPrefix,
      defaultTitle,
      fieldId,
      idPrefix,
      isModeFieldResource,
      kernel,
      kindLabel,
      onPhaseChangeDeg,
      pinModeVisualization,
      ref,
      selection,
    ],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceModalModeResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <ModalModeResultInspectorShared
      breadcrumbsPrefix={["Results", "Resonance & FMR"]}
      defaultTitle="Mode Shape"
      idPrefix="results.resonance.modal.mode"
      kindLabel="Complex spatial eigenmode profile"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}

export function ResonanceModalCouplingResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.coupling:${selection.nodeId ?? "cpl"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "RF Coupling"],
        title: selection.label || "Modal RF Coupling & Oscillator Strength",
        kindLabel: "Uniform drive overlap |<h_rf | delta_m>|^2",
        facts: [
          { id: "gate", label: "Qualification", value: "FMR-active overlap" },
          { id: "obs", label: "Observable", value: ref?.observableId ?? "rf coupling" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Published RF Coupling Weights",
        rows: [
          {
            type: "readonly",
            label: "Observable evidence",
            mono: true,
            format: () => ref?.observableId ?? "rf coupling observable",
          },
          {
            type: "readonly",
            label: "Physical meaning",
            format: () => "Modal drive overlap / oscillator-strength evidence",
          },
          {
            type: "readonly",
            label: "FMR naming gate",
            format: () => "FMR-active because the manifest publishes coupling evidence",
          },
          {
            type: "readonly",
            label: "Visualization handoff",
            format: () => "Select a mode field to inspect phase-resolved 3D data",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <EigenModesInspectorPanel selection={selection} />,
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
