"use client";

import type { EChartsOption } from "echarts";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  minMaxFinite,
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  type EigenBranch,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { EigenBranchInspectorPanel } from "../../../panels/frequency-domain/EigenBranchInspectorPanel";
import {
  EigenBranchesInspectorPanel,
  EigenModesInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
} from "../../../panels/frequency-domain/FrequencyDomainResultInspectors";
import { FrequencyDomainBranchTable } from "../../../panels/FrequencyDomainTables";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  frequencyDomainRef,
  makeSimplePhysicsResultSpec,
  BranchDispersionAndGroupVelocityChart,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
  ModeHarmonicPhaseControls,
  buildRefProvenanceRows,
} from "./resonanceShared";
import { ModalModeResultInspectorShared } from "./ResonanceModalSpecs";
import { DrivenResponseFieldInspectorShared } from "./ResonanceKittelAndResponseSpecs";

export function DispersionBranchesResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedDispersionBranches {...props} />
  ) : (
    <DispersionBranchesView {...props} branchesData={null} dispersionData={null} />
  );
}

function ConnectedDispersionBranches(props: InspectorPanelProps) {
  const branchesRes = useFrequencyDomainEigenBranchesResource();
  const dispersionRes = useFrequencyDomainEigenDispersionResource();
  return (
    <DispersionBranchesView
      {...props}
      branchesData={branchesRes.data ?? null}
      dispersionData={dispersionRes.data ?? null}
    />
  );
}

function DispersionBranchesView({
  branchesData,
  dispersionData,
  selection,
}: InspectorPanelProps & {
  branchesData: Parameters<typeof buildEigenBranchesModel>[0];
  dispersionData: Parameters<typeof buildEigenBranchesModel>[1];
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const branchModel = useMemo(
    () => buildEigenBranchesModel(branchesData, dispersionData),
    [branchesData, dispersionData],
  );
  const dispersionPoints = useMemo(
    () => buildEigenDispersionChartModel(dispersionData ?? null).points,
    [dispersionData],
  );
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(
    ref?.branchId ?? null,
  );
  const activeBranchId =
    selectedBranchId ?? ref?.branchId ?? branchModel.branches[0]?.branchId ?? null;

  const branchSelection = useMemo<Selection>(() => {
    if (!activeBranchId) return selection;
    return {
      ...selection,
      ref: {
        ...(ref ?? {
          kind: selection.kind ?? "results.dispersion.modal.branches",
          nodeId: selection.nodeId ?? `results:eigen:branch:${activeBranchId}`,
          type: "frequency-domain" as const,
        }),
        branchId: activeBranchId,
      },
    };
  }, [activeBranchId, ref, selection]);

  const selectedBranchPoints = useMemo(
    () =>
      activeBranchId
        ? dispersionPoints.filter((pt) => pt.branchId === activeBranchId)
        : dispersionPoints,
    [activeBranchId, dispersionPoints],
  );

  const selectBranch = useCallback(
    (branch: EigenBranch) => {
      setSelectedBranchId(branch.branchId);
      kernel?.selection.set(
        {
          kind: "results.dispersion.modal.branches",
          label: branch.label ?? `Branch ${branch.branchId}`,
          nodeId: selection.nodeId ?? `results:eigen:branch:${branch.branchId}`,
          objectId: null,
          ref: {
            ...(ref ?? {
              kind: "results.dispersion.modal.branches",
              nodeId: selection.nodeId ?? `results:eigen:branch:${branch.branchId}`,
              type: "frequency-domain" as const,
            }),
            branchId: branch.branchId,
          },
        },
        "inspector",
      );
    },
    [kernel, ref, selection.nodeId],
  );

  const hasBranches = branchModel.branches.length > 0;
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.modal.branches:${selection.nodeId ?? "branches"}`,
        breadcrumbs: ["Results", "Dispersion", "Mode Branches"],
        title: selection.label || "Tracked Spin-Wave Branches",
        kindLabel: "Eigenvector-overlap tracked dispersion branches",
        stateLabel: hasBranches
          ? `${branchModel.branches.length} branches`
          : "Ready",
        facts: [
          {
            id: "count",
            label: "Branches",
            value: String(branchModel.branches.length),
          },
          { id: "tracker", label: "Tracking", value: "Mode overlap continuity" },
        ],
        sectionTitle: "Branch Continuity, Group Velocity & Samples",
        rows: [
          {
            type: "readonly",
            label: "Branch tracking",
            format: () => "Tracks branch identity across k steps via complex mode overlap",
          },
          ...(selectedBranchPoints.length > 0
            ? [
                {
                  type: "custom" as const,
                  label: "Branch dispersion & group velocity",
                  wide: true,
                  render: () => (
                    <BranchDispersionAndGroupVelocityChart points={selectedBranchPoints} />
                  ),
                },
              ]
            : []),
          ...(hasBranches
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <FrequencyDomainBranchTable
                      branches={branchModel.branches}
                      onSelectBranch={selectBranch}
                    />
                  ),
                },
              ]
            : []),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <EigenBranchesInspectorPanel selection={branchSelection} />
                      <EigenBranchInspectorPanel selection={branchSelection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [
      branchModel.branches,
      branchSelection,
      hasBranches,
      kernel,
      selectBranch,
      selectedBranchPoints,
      selection.label,
      selection.nodeId,
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

export function DispersionModesAtKResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.modal.modes_at_k:${selection.nodeId ?? "modes_k"}`,
        breadcrumbs: ["Results", "Dispersion", "Modes at k"],
        title: selection.label || "Spatial Modes at Wavevector k",
        kindLabel: "Bloch envelope & phase-modulated 3D modes",
        commitMode: "liveViewport",
        onResetDisplay: () => {
          if (!kernel) return;
          void kernel.commands.execute(
            "analysis.frequency-domain.stop-3d-animation",
            createCommandContext("inspector", kernel),
          );
          kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
        },
        facts: [{ id: "form", label: "Envelope", value: "u_{n,k}(r) exp(i k·r)" }],
        sectionTitle: "Bloch Mode Shapes & 3D Activation",
        rows: [
          {
            type: "custom",
            label: "3D Bloch phase animation",
            wide: true,
            render: () => <ModeHarmonicPhaseControls />,
          },
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

export function DispersionModeAtKResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <ModalModeResultInspectorShared
      breadcrumbsPrefix={["Results", "Dispersion"]}
      defaultTitle="Bloch Eigenmode Profile"
      idPrefix="results.dispersion.modal.mode_at_k"
      kindLabel="Wavevector-resolved 3D mode profile"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}

export function DispersionResponseMapResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedDispersionResponseMap {...props} />
  ) : (
    <DispersionResponseMapView {...props} payload={null} />
  );
}

function ConnectedDispersionResponseMap(props: InspectorPanelProps) {
  const mapRes = useFrequencyDomainResponseSweepResource();
  const payload = (mapRes.data?.payload ?? null) as Record<string, unknown> | null;
  return <DispersionResponseMapView {...props} payload={payload} />;
}

function ResponseMapHeatmapChart({
  observable,
  points,
  sliceMode,
}: {
  observable: string;
  points: ReadonlyArray<Record<string, unknown>>;
  sliceMode: string;
}) {
  const buildOption = useMemo(
    () => (palette: ResolvedChartThemePalette): EChartsOption => {
      const kSet = new Set<number>();
      const fSet = new Set<number>();
      for (const pt of points) {
        const k = typeof pt.k_rad_per_m === "number" ? Number((pt.k_rad_per_m * 1e-6).toFixed(3)) : 0;
        const f = typeof pt.frequency_hz === "number" ? Number((pt.frequency_hz * 1e-9).toFixed(3)) : 0;
        kSet.add(k);
        fSet.add(f);
      }
      const kVals = Array.from(kSet).toSorted((a, b) => a - b);
      const fVals = Array.from(fSet).toSorted((a, b) => a - b);
      const resolvePointValue = (pt: Record<string, unknown>): number => {
        const rawVal =
          observable === "imag"
            ? (pt.absorbed_power_density ?? pt.imag ?? pt.amplitude)
            : observable === "real"
              ? (pt.real ?? pt.amplitude)
              : pt.amplitude;
        return typeof rawVal === "number" && Number.isFinite(rawVal) ? rawVal : 0;
      };
      if (sliceMode === "fixed_k") {
        const targetK = kVals[0] ?? 0;
        const slicePts = points
          .filter((pt) => {
            const k = typeof pt.k_rad_per_m === "number" ? Number((pt.k_rad_per_m * 1e-6).toFixed(3)) : 0;
            return k === targetK;
          })
          .map((pt) => [
            typeof pt.frequency_hz === "number" ? pt.frequency_hz * 1e-9 : 0,
            resolvePointValue(pt),
          ]);
        return {
          grid: { left: 48, right: 18, top: 16, bottom: 34 },
          xAxis: {
            type: "value",
            name: "f (GHz)",
            nameLocation: "middle",
            nameGap: 22,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          yAxis: {
            type: "value",
            name: observable,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          series: [
            {
              type: "line",
              data: slicePts,
              lineStyle: { color: palette.series[0] ?? palette.textPrimary },
              showSymbol: true,
              symbolSize: 5,
            },
          ],
        };
      }
      if (sliceMode === "fixed_f") {
        const targetF = fVals[0] ?? 0;
        const slicePts = points
          .filter((pt) => {
            const f = typeof pt.frequency_hz === "number" ? Number((pt.frequency_hz * 1e-9).toFixed(3)) : 0;
            return f === targetF;
          })
          .map((pt) => [
            typeof pt.k_rad_per_m === "number" ? pt.k_rad_per_m * 1e-6 : 0,
            resolvePointValue(pt),
          ]);
        return {
          grid: { left: 48, right: 18, top: 16, bottom: 34 },
          xAxis: {
            type: "value",
            name: "k (rad/um)",
            nameLocation: "middle",
            nameGap: 22,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          yAxis: {
            type: "value",
            name: observable,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          series: [
            {
              type: "line",
              data: slicePts,
              lineStyle: { color: palette.series[0] ?? palette.textPrimary },
              showSymbol: true,
              symbolSize: 5,
            },
          ],
        };
      }
      const data = points.map((pt) => {
        const k = typeof pt.k_rad_per_m === "number" ? Number((pt.k_rad_per_m * 1e-6).toFixed(3)) : 0;
        const f = typeof pt.frequency_hz === "number" ? Number((pt.frequency_hz * 1e-9).toFixed(3)) : 0;
        return [kVals.indexOf(k), fVals.indexOf(f), resolvePointValue(pt)];
      });
      const zRange = minMaxFinite(data.map((d) => d[2] ?? 0));
      return {
        grid: { left: 48, right: 18, top: 16, bottom: 34 },
        xAxis: {
          type: "category",
          name: "k (rad/um)",
          nameLocation: "middle",
          nameGap: 22,
          data: kVals.map(String),
        },
        yAxis: {
          type: "category",
          name: "f (GHz)",
          data: fVals.map(String),
        },
        visualMap: {
          min: 0,
          max: Math.max(1e-9, zRange?.max ?? 0),
          show: false,
          inRange: { color: [palette.borderSubtle, palette.series[0] ?? palette.textPrimary] },
        },
        series: [
          {
            type: "heatmap",
            data,
          },
        ],
      };
    },
    [observable, points, sliceMode],
  );

  if (points.length === 0) return null;
  return (
    <ScientificEChart
      ariaLabel="Spin-wave driven response map A(k, f)"
      height={200}
      optionBuilder={buildOption}
    />
  );
}

function DispersionResponseMapView({
  payload,
  selection,
}: InspectorPanelProps & { payload: Record<string, unknown> | null }) {
  const kernel = useContext(KernelContext);
  const [mapObservable, setMapObservable] = useState("amplitude");
  const [sliceMode, setSliceMode] = useState("2d_map");

  const mapPoints = useMemo(
    () =>
      Array.isArray(payload?.points)
        ? (payload.points as Array<Record<string, unknown>>)
        : [],
    [payload],
  );
  const kSampleCount = useMemo(() => {
    if (Array.isArray(payload?.k_samples)) return payload.k_samples.length;
    const ks = new Set(
      mapPoints.flatMap((p) => (typeof p.k_rad_per_m === "number" ? [p.k_rad_per_m] : [])),
    );
    return ks.size;
  }, [mapPoints, payload]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.driven.response_map:${selection.nodeId ?? "rmap"}`,
        breadcrumbs: ["Results", "Dispersion", "Driven Response Map"],
        title: selection.label || "Driven Spin-Wave Response Map A(k, f)",
        kindLabel: "2D wavevector-frequency susceptibility & power map",
        stateLabel: payload ? "Published" : "Ready",
        facts: [
          { id: "axes", label: "Axes", value: "(k [rad/m], f [GHz])" },
          {
            id: "ksamples",
            label: "k-samples",
            value: kSampleCount > 0 ? String(kSampleCount) : "Published",
          },
        ],
        sectionTitle: "Response Map Controls & 2D Heatmap",
        rows: [
          {
            type: "custom",
            label: "Map observable & slice view",
            wide: true,
            render: () => (
              <div className="grid gap-2.5">
                <Select value={mapObservable} onValueChange={setMapObservable}>
                  <SelectTrigger aria-label="Map observable">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="fm-inspector-select-content">
                    <SelectItem value="amplitude">Response amplitude |A(k, f)|</SelectItem>
                    <SelectItem value="imag">Absorbed power P_abs(k, f)</SelectItem>
                    <SelectItem value="real">Dispersive component Re chi(k, f)</SelectItem>
                  </SelectContent>
                </Select>
                <SegmentedControl
                  aria-label="Response map slice mode"
                  options={[
                    { label: "2D Map", value: "2d_map" },
                    { label: "Fixed-k Slice", value: "fixed_k" },
                    { label: "Fixed-f Slice", value: "fixed_f" },
                  ]}
                  value={sliceMode}
                  onValueChange={setSliceMode}
                />
                {mapPoints.length > 0 ? (
                  <ResponseMapHeatmapChart
                    observable={mapObservable}
                    points={mapPoints}
                    sliceMode={sliceMode}
                  />
                ) : null}
              </div>
            ),
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <FrequencyDomainResponseMapInspectorPanel selection={selection} />
                  ),
                },
              ]
            : []),
        ],
      }),
    [kSampleCount, kernel, mapObservable, mapPoints, payload, selection, sliceMode],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionResponseFieldAtKResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <DrivenResponseFieldInspectorShared
      breadcrumbsPrefix={["Results", "Dispersion"]}
      defaultTitle="Driven Response Field at (k, f)"
      idPrefix="results.dispersion.driven.field_at_k"
      kindLabel="Steady-state Floquet spatial field delta_m(r; k, f)"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}
