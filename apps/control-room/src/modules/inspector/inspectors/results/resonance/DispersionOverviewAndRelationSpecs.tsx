"use client";

import {
  Box,
  Compass,
  GitCommitHorizontal,
  LineChart,
  Waves,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useFrequencyDomainEigenDispersionResource } from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { minMaxFinite } from "@/shared/charts/ScientificEChart";
import {
  buildEigenDispersionChartModel,
  buildEigenDispersionPointSelectionRef,
  eigenModeFieldAvailable,
  type EigenDispersionPoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { ReferenceImportSection } from "../../../panels/analysis-results/ReferenceImportSection";
import { EigenDispersionInspectorPanel } from "../../../panels/frequency-domain/EigenDispersionInspectorPanel";
import {
  EigenKPathInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
} from "../frequency-domain";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  frequencyDomainRef,
  makeSimplePhysicsResultSpec,
  buildRefProvenanceRows,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
  resolveSelectedDispersionPoint,
  estimateGroupVelocityMPerS,
  type ReadOnlySpectralResultDraft,
  BranchDispersionAndGroupVelocityChart,
} from "./resonanceShared";

export function DispersionOverviewResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.root:${selection.nodeId ?? "disp"}`,
        breadcrumbs: ["Results", "Dispersion & k-resolved"],
        title: selection.label || "Dispersion & k-Resolved Response",
        kindLabel: "Spin-wave branches f_n(k) and driven maps A(k, f)",
        facts: [
          { id: "modal", label: "Modal", value: "Bloch / Floquet f_n(k)" },
          { id: "driven", label: "Driven", value: "Susceptibility map chi(k, f)" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Wavevector-Resolved Products",
        rows: [
          {
            type: "readonly",
            label: "Modal relation",
            format: () => "Modal relation fₙ(k) from eigenfrequency branches",
          },
          {
            type: "readonly",
            label: "Driven map",
            format: () =>
              "Driven map A(k,f), χ(k,f), or P_abs(k,f); not a modal dispersion relation",
          },
          {
            type: "readonly",
            label: "Group velocity",
            format: () => "Computed as vg = d omega / dk along continuous k-path segments",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <FrequencyDomainDispersionInspectorPanel selection={selection} />
                  ),
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

export function DispersionModalStageResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.modal.stage:${selection.nodeId ?? "mstage"}`,
        breadcrumbs: ["Results", "Dispersion", selection.label || "Modal Stage"],
        title: selection.label || "Modal Dispersion Stage",
        kindLabel: "Bloch / Floquet modal stage provenance",
        facts: [{ id: "bc", label: "Boundary", value: "Floquet periodic" }],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Stage Contract & Provenance",
        rows: [
          {
            type: "readonly",
            label: "Operator",
            format: () => "Wavevector-parameterized linearized LLG operator L(k)",
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
                      <EigenProvenanceInspectorPanel
                        canonicalFamily="Modal dispersion lane · f_n(k)"
                        linksTitle="Modal Dispersion Provenance Links"
                        selection={selection}
                        title="Modal Dispersion Provenance"
                      />
                    </div>
                  ),
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

export function DispersionDrivenStageResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.driven.stage:${selection.nodeId ?? "dstage"}`,
        breadcrumbs: ["Results", "Dispersion", selection.label || "Driven Stage"],
        title: selection.label || "Driven k-Resolved Stage",
        kindLabel: "Wavevector-resolved harmonic response provenance",
        facts: [{ id: "bc", label: "Boundary", value: "Floquet periodic" }],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Driven Stage Contract & Provenance",
        rows: [
          {
            type: "readonly",
            label: "Excitation",
            format: () => "Spatial-harmonic RF drive across k-grid / k-path",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <FrequencyResponseStudyInspectorPanel selection={selection} />
                      <FrequencyResponseProvenanceInspectorPanel
                        canonicalFamily="Driven response-map lane · A(k,f)"
                        linksTitle="Driven Response-Map Provenance Links"
                        selection={selection}
                        title="Driven Response-Map Provenance"
                      />
                    </div>
                  ),
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

export function DispersionKSamplingResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedDispersionKSampling {...props} />
  ) : (
    <DispersionKSamplingView {...props} points={[]} />
  );
}

function ConnectedDispersionKSampling(props: InspectorPanelProps) {
  const dispRes = useFrequencyDomainEigenDispersionResource();
  const points = useMemo(
    () => buildEigenDispersionChartModel(dispRes.data ?? null).points,
    [dispRes.data],
  );
  return <DispersionKSamplingView {...props} points={points} />;
}

function DispersionKSamplingView({
  points,
  selection,
}: InspectorPanelProps & { points: readonly EigenDispersionPoint[] }) {
  const kernel = useContext(KernelContext);
  const uniqueSamples = useMemo(() => {
    const byIdx = new Map<number, EigenDispersionPoint>();
    for (const pt of points) {
      if (!byIdx.has(pt.sampleIndex)) byIdx.set(pt.sampleIndex, pt);
    }
    return Array.from(byIdx.values()).toSorted((a, b) => a.sampleIndex - b.sampleIndex);
  }, [points]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.k_sampling:${selection.nodeId ?? "ksamp"}`,
        breadcrumbs: ["Results", "Dispersion", "Wavevector Sampling"],
        title: selection.label || "Wavevector Sampling Path",
        kindLabel: "Brillouin / spin-wave k-space coordinates",
        facts: [
          { id: "unit", label: "SI unit", value: "rad/m" },
          { id: "samples", label: "k-samples", value: String(uniqueSamples.length) },
        ],
        sectionTitle: "k-Space Vertices, High-Symmetry Labels & Wavevector Table",
        rows: [
          {
            type: "readonly",
            label: "Path arc-length s",
            format: () => "Monotonic cumulative wavevector distance in rad/m",
          },
          ...(uniqueSamples.length > 0
            ? [
                {
                  type: "custom" as const,
                  label: "Wavevector sample table",
                  wide: true,
                  render: () => (
                    <div className="overflow-x-auto text-xs">
                      <table className="w-full text-left tabular-nums border-collapse">
                        <thead>
                          <tr className="border-b border-fm-border text-fm-muted">
                            <th className="py-1 px-1.5">Sample</th>
                            <th className="py-1 px-1.5">Label</th>
                            <th className="py-1 px-1.5">k (rad/um)</th>
                            <th className="py-1 px-1.5">s (rad/um)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uniqueSamples.map((smp) => (
                            <tr
                              className="border-b border-fm-border-subtle"
                              key={smp.sampleIndex}
                            >
                              <td className="py-1 px-1.5">{smp.sampleIndex}</td>
                              <td className="py-1 px-1.5">{smp.sampleLabel ?? "—"}</td>
                              <td className="py-1 px-1.5 font-mono">
                                {smp.wavevectorKf
                                  ? smp.wavevectorKf
                                      .map((v) => (v * 1e-6).toFixed(2))
                                      .join(", ")
                                  : "—"}
                              </td>
                              <td className="py-1 px-1.5">
                                {(smp.pathS * 1e-6).toFixed(3)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ),
                },
              ]
            : []),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <EigenKPathInspectorPanel selection={selection} />,
                },
              ]
            : []),
        ],
      }),
    [kernel, selection, uniqueSamples],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionRelationResultInspector(
  props: InspectorPanelProps & {
    onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
    testDispersionPoints?: readonly EigenDispersionPoint[];
  },
) {
  const kernel = useContext(KernelContext);
  if (props.testDispersionPoints || !kernel) {
    return (
      <DispersionRelationResultView
        {...props}
        points={props.testDispersionPoints ?? []}
      />
    );
  }
  return <ConnectedDispersionRelationResultInspector {...props} />;
}

function ConnectedDispersionRelationResultInspector(
  props: InspectorPanelProps & {
    onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
  },
) {
  const dispRes = useFrequencyDomainEigenDispersionResource();
  const points = useMemo(
    () => buildEigenDispersionChartModel(dispRes.data ?? null).points,
    [dispRes.data],
  );
  return (
    <DispersionRelationResultView
      {...props}
      hostFullMasterPanel
      points={points}
    />
  );
}

function DispersionRelationResultView({
  hostFullMasterPanel = false,
  onSelectDispersionSelection,
  points,
  selection,
}: InspectorPanelProps & {
  hostFullMasterPanel?: boolean;
  onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
  points: readonly EigenDispersionPoint[];
}) {
  const kernel = useContext(KernelContext);

  const selectedPoint = useMemo(
    () => resolveSelectedDispersionPoint(selection, points),
    [points, selection],
  );
  const selectedVg = useMemo(
    () => (selectedPoint ? estimateGroupVelocityMPerS(points, selectedPoint) : null),
    [points, selectedPoint],
  );

  const handleSelectPoint = useCallback(
    (pt: EigenDispersionPoint) => {
      const ownerRef = frequencyDomainRef(selection);
      const rawRef = buildEigenDispersionPointSelectionRef(pt, {
        analysisRunId: ownerRef?.analysisRunId,
        analysisStageId: ownerRef?.analysisStageId,
        artifactPath: ownerRef?.artifactPath,
        artifactRevision: ownerRef?.artifactRevision,
        calculationMode: "dispersion_modal",
        datasetId: ownerRef?.datasetId,
        datasetRevision: ownerRef?.datasetRevision,
      });
      // Dispersion P0 #1 fix: preserve canonical physics-first selection.kind!
      const canonicalKind =
        selection.kind === "results.dispersion.modal.relation" ||
        selection.kind === "results.dispersion.modal.branches"
          ? selection.kind
          : "results.dispersion.modal.relation";
      const nextRef =
        rawRef.type === "frequency-domain"
          ? {
              ...rawRef,
              kind: canonicalKind,
              modeIndex: pt.rawModeIndex,
              sampleIndex: pt.sampleIndex,
            }
          : rawRef;
      const nextSelection: Omit<Selection, "moduleSource"> = {
        kind: canonicalKind,
        label: `k sample ${pt.sampleIndex}, mode ${pt.rawModeIndex}`,
        nodeId: selection.nodeId ?? `disp:${pt.sampleIndex}:${pt.rawModeIndex}`,
        objectId: null,
        ref: nextRef,
      };
      onSelectDispersionSelection?.(nextSelection);
      kernel?.selection.set(nextSelection, "inspector");
    },
    [kernel, onSelectDispersionSelection, selection],
  );

  const activateSelectedModeIn3D = useCallback(() => {
    if (!kernel || !selectedPoint || !eigenModeFieldAvailable(selectedPoint) || !selectedPoint.modeFieldId) {
      return;
    }
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.dispersion.modal.relation",
      }),
      {
        fieldId: selectedPoint.modeFieldId,
        label: `k sample ${selectedPoint.sampleIndex}, mode ${selectedPoint.rawModeIndex}`,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  }, [kernel, selectedPoint]);

  const provenanceRows = useMemo(() => buildRefProvenanceRows(selection), [selection]);

  const fBounds = useMemo(
    () => minMaxFinite(points.map((p) => p.frequencyHz)),
    [points],
  );

  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `results.dispersion.modal.relation:${selection.nodeId ?? "rel"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "disp", label: "Dispersion" },
          { id: "rel", label: selection.label || "Dispersion Relation f_n(k)" },
        ],
        ...(kernel && selectedPoint && eigenModeFieldAvailable(selectedPoint) && selectedPoint.modeFieldId
          ? {
              primaryHeaderAction: {
                label: "Activate in 3D",
                icon: Box,
                onRun: () => activateSelectedModeIn3D(),
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: LineChart,
        title: () => selection.label || "Spin-Wave Dispersion Relation",
        kindLabel: "Modal dispersion f_n(k) and group velocity vg(k)",
        statePill: () => ({
          tone: points.length > 0 ? "ok" : "neutral",
          label: points.length > 0 ? `${points.length} samples` : "Empty",
        }),
      },
      facts: () => [
        { id: "samples", label: "Points", value: String(points.length) },
        {
          id: "f-span",
          label: "Band",
          value: fBounds
            ? `${formatFrequencyHz(fBounds.min)} – ${formatFrequencyHz(fBounds.max)}`
            : "—",
        },
        ...(selectedPoint
          ? [
              {
                id: "sel-f",
                label: "Selected f",
                value: formatFrequencyHz(selectedPoint.frequencyHz),
              },
              {
                id: "sel-vg",
                label: "Group velocity",
                value:
                  selectedVg != null
                    ? `${(selectedVg * 1e-3).toFixed(2)} km/s`
                    : "0.00 km/s",
              },
            ]
          : []),
      ],
      sections: [
        {
          id: "dispersion-chart",
          title: "Dispersion f(k) & Group Velocity vg(k)",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Two-panel dispersion chart",
              wide: true,
              render: () => (
                <BranchDispersionAndGroupVelocityChart
                  points={points}
                  onSelectPoint={handleSelectPoint}
                />
              ),
            },
            ...(points.length > 0 && !hostFullMasterPanel
              ? [
                  {
                    type: "custom" as const,
                    label: "Sample selector",
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap gap-1.5">
                        {points.map((pt) => (
                          <Button
                            aria-label={`Select dispersion point sample ${pt.sampleIndex} mode ${pt.rawModeIndex}`}
                            key={`${pt.sampleIndex}:${pt.rawModeIndex}`}
                            size="sm"
                            type="button"
                            variant={
                              selectedPoint?.sampleIndex === pt.sampleIndex &&
                              selectedPoint?.rawModeIndex === pt.rawModeIndex
                                ? "primary"
                                : "secondary"
                            }
                            onClick={() => handleSelectPoint(pt)}
                          >
                            k#{pt.sampleIndex} · {(pt.frequencyHz * 1e-9).toFixed(2)} GHz
                          </Button>
                        ))}
                      </div>
                    ),
                  },
                ]
              : []),
            ...(hostFullMasterPanel && kernel
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid min-w-0 gap-3">
                        <EigenDispersionInspectorPanel
                          selection={selection}
                          onSelectDispersionSelection={onSelectDispersionSelection}
                        />
                        <ReferenceImportSection />
                      </div>
                    ),
                  },
                ]
              : []),
          ],
        },
        ...(!hostFullMasterPanel
          ? [
              {
                id: "selected-dispersion-point",
                title: "Selected (k, omega) Point",
                icon: Compass,
                defaultOpen: true,
                rows: selectedPoint
                  ? [
                      {
                        type: "readonly" as const,
                        label: "Wavevector coordinate k",
                        mono: true,
                        format: () => `${(selectedPoint.pathS * 1e-6).toFixed(3)} rad/um`,
                      },
                      {
                        type: "readonly" as const,
                        label: "Wavevector components (kx, ky, kz)",
                        mono: true,
                        format: () =>
                          selectedPoint.wavevectorKf
                            ? `${selectedPoint.wavevectorKf
                                .map((v) => (v * 1e-6).toFixed(3))
                                .join(", ")} rad/um`
                            : "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Eigenfrequency f",
                        mono: true,
                        format: () => `${(selectedPoint.frequencyHz * 1e-9).toFixed(4)} GHz`,
                      },
                      {
                        type: "readonly" as const,
                        label: "Linewidth (FWHM)",
                        mono: true,
                        format: () =>
                          selectedPoint.linewidthHz != null
                            ? formatFrequencyHz(selectedPoint.linewidthHz)
                            : "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Group velocity vg",
                        mono: true,
                        format: () =>
                          selectedVg != null
                            ? `${(selectedVg * 1e-3).toFixed(3)} km/s`
                            : "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Branch provenance",
                        mono: true,
                        format: () => selectedPoint.branchId ?? "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Residual",
                        mono: true,
                        format: () =>
                          selectedPoint.residualNorm != null
                            ? selectedPoint.residualNorm.toExponential(3)
                            : "—",
                      },
                    ]
                  : [
                      {
                        type: "readonly" as const,
                        label: "Selection",
                        format: () =>
                          "Click any point on f_n(k) to inspect k, f, and group velocity vg",
                      },
                    ],
              },
            ]
          : []),
        ...(provenanceRows.length
          ? [{
              id: "dispersion-provenance",
              title: "Provenance",
              icon: GitCommitHorizontal,
              defaultOpen: false,
              rows: provenanceRows,
            }]
          : []),
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activateSelectedModeIn3D,
      fBounds,
      handleSelectPoint,
      hostFullMasterPanel,
      kernel,
      onSelectDispersionSelection,
      points,
      provenanceRows,
      selectedPoint,
      selectedVg,
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
