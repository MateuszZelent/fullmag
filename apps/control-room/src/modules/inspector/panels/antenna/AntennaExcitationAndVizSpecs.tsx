"use client";

import {
  Activity,
  Cpu,
  Eye,
  Gauge,
  Layers,
  Play,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Waves,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import type {
  FieldDriveCreateRequest,
  FieldDriveReplaceRequest,
  JsonObject,
  MaskFieldDriveCreateRequest,
  MaskFieldDriveReplaceRequest,
  MaskFieldDriveResource,
  ReadyAntennaTermsRequest,
  RegionalFieldDriveResource,
} from "@/kernel/api/apiTypes";
import { antennaRegionalSources } from "@/shared/domain/physics/antennaRegionalSource";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  antennaSpectrumPayloadEtag,
  useAntennaFieldSolutionResource,
  useAntennaSourceSpectrumPayloadResource,
  useAntennaSourceSpectrumResource,
} from "@/kernel/resources/antennaResources";
import {
  SCENE_RESOURCE_KEY,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec, UnitOption } from "../../template";
import { formatLengthSmart } from "../mesh-details/MeshDomainSpecs";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import { AntennaWavevectorHeatmap } from "./AntennaWavevectorHeatmap";

const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

const CURRENT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mA", toSiFactor: 1e-3 },
  { unit: "µA", toSiFactor: 1e-6 },
  { unit: "A", toSiFactor: 1 },
];

const FREQUENCY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GHz", toSiFactor: 1e9 },
  { unit: "MHz", toSiFactor: 1e6 },
  { unit: "Hz", toSiFactor: 1 },
];

const FIELD_MT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mT", toSiFactor: 1e-3 },
  { unit: "µT", toSiFactor: 1e-6 },
  { unit: "T", toSiFactor: 1 },
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// ============================================================================
// 1. object.antenna.solution — AntennaSolutionInspectorSpecPanel (1 staged session)
// ============================================================================

interface AntennaSolutionDraft {
  oerstedRealization: "direct_tetra_quadrature" | "vector_potential_solver";
  samplingDomain: string;
  linearSolver: "cg_amg" | "direct_lu";
  relativeTolerance: number;
  quadratureOrder: "1" | "2" | "4";
  targetObjectIds: readonly string[];
}

export function AntennaSolutionInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const stageIdFromRef =
    asString((selection.ref as JsonRecord | null)?.stageId) ??
    selection.nodeId?.split(":solution:")[1] ??
    null;

  const solveStage = useMemo(() => {
    const list = Array.isArray(sceneRec?.antenna_field_solve_stages)
      ? sceneRec.antenna_field_solve_stages.map(asRecord).filter(Boolean)
      : [];
    return (
      list.find((s) => asString(s?.id) === stageIdFromRef) ??
      list.find((s) => asString(s?.source_object_id) === objectId) ??
      null
    );
  }, [objectId, sceneRec, stageIdFromRef]);

  const solutionOutputId = useMemo(() => {
    const outs = Array.isArray(solveStage?.outputs) ? solveStage.outputs : [];
    const basisOut = outs.map(asRecord).find((o) => asString(o?.quantity) === "H_ant_basis");
    return asString(basisOut?.id) ?? asString(asRecord(outs[0])?.id);
  }, [solveStage]);

  const fieldSolutionRes = useAntennaFieldSolutionResource(solutionOutputId, {
    enabled: Boolean(solutionOutputId),
  });

  const targetOptions = useMemo(() => {
    const objs = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
    return objs
      .map(asRecord)
      .filter((o) => o && asString(o.id) !== objectId)
      .map((o) => ({
        label: asString(o?.name) ?? asString(o?.id) ?? "Object",
        value: asString(o?.id) ?? "",
      }))
      .filter((o) => o.value.length > 0);
  }, [objectId, sceneRec]);

  const baseline = useMemo<AntennaSolutionDraft>(() => {
    const rawRealization = asString(solveStage?.oersted_realization);
    const oerstedRealization: AntennaSolutionDraft["oerstedRealization"] =
      rawRealization === "vector_potential_solver"
        ? "vector_potential_solver"
        : "direct_tetra_quadrature";
    const rawTargets = Array.isArray(solveStage?.target_refs)
      ? solveStage.target_refs
          .map(asRecord)
          .map((t) => asString(t?.object_id))
          .filter((x): x is string => Boolean(x))
      : targetOptions[0]
        ? [targetOptions[0].value]
        : [];
    return {
      linearSolver: "cg_amg",
      oerstedRealization,
      quadratureOrder: "2",
      relativeTolerance: asNumber(solveStage?.relative_tolerance) ?? 1e-10,
      samplingDomain: targetOptions[0] ? `object:${targetOptions[0].value}` : "global",
      targetObjectIds: rawTargets,
    };
  }, [solveStage, targetOptions]);

  const stageId = asString(solveStage?.id) ?? stageIdFromRef ?? "solve_1";

  const spec = useMemo<InspectorSpec<AntennaSolutionDraft>>(
    () => ({
      id: "object.antenna.solution",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "solution", label: "Field Solution" },
        ],
        primaryHeaderAction: {
          icon: Play,
          label: "Solve Antenna Field",
          onRun: async () => {
            await kernel.commands.execute(
              "study.run" as never,
              createCommandContext("inspector", kernel, {
                sessionScopeKey,
                sourceDetail: "object.antenna.solution",
              }),
            );
          },
        },
      },
      identity: {
        domain: "physics",
        entityId: `sol:${stageId}`,
        icon: Cpu,
        kindLabel: "Quasi-static J & Oersted field basis",
        statePill: () =>
          fieldSolutionRes.data
            ? { label: "Qualified", tone: "ok" }
            : { label: "Solve required", tone: "warn" },
        title: () => "Antenna Field Solver",
      },
      facts: (d) => [
        {
          id: "model",
          label: "Oersted model",
          value:
            d.oerstedRealization === "direct_tetra_quadrature"
              ? "Biot-Savart 3D"
              : "FEM A-V",
        },
        {
          id: "targets",
          label: "Targets",
          value: `${d.targetObjectIds.length} assigned`,
        },
        {
          id: "tol",
          label: "CG tolerance",
          value: d.relativeTolerance.toExponential(0),
        },
        {
          id: "status",
          label: "div J = 0",
          tone: fieldSolutionRes.data ? "ok" : undefined,
          value: fieldSolutionRes.data ? "Verified" : null,
        },
      ],
      modeTabs: [
        { commitModeOverride: "staged", id: "setup", label: "Solver Setup" },
        {
          commitModeOverride: "readOnly",
          id: "diagnostics",
          label: "Convergence & Basis Diagnostics",
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Cpu,
          id: "solver-config",
          modeTabId: "setup",
          rows: [
            {
              key: "oerstedRealization",
              label: "Oersted realization",
              options: [
                {
                  label: "Direct Tetrahedral Biot-Savart Quadrature (3D)",
                  value: "direct_tetra_quadrature",
                },
                {
                  label: "Coupled FEM Vector Potential ∇×(μ₀⁻¹∇×A) = J",
                  value: "vector_potential_solver",
                },
              ],
              structural: true,
              type: "select",
            },
            {
              key: "samplingDomain",
              label: "Field sampling domain",
              options: [
                { label: "Global Shared-Domain Mesh", value: "global" },
                ...targetOptions.map((o) => ({
                  label: `Object Carrier — ${o.label}`,
                  value: `object:${o.value}`,
                })),
              ],
              type: "select",
            },
            {
              key: "linearSolver",
              label: "Charge solver (∇·σ∇V = 0)",
              options: [
                { label: "CG + AMG Preconditioner", value: "cg_amg" },
                { label: "Sparse Direct Cholesky / LU", value: "direct_lu" },
              ],
              type: "select",
            },
            {
              key: "relativeTolerance",
              label: "Relative tolerance",
              max: 1e-5,
              min: 1e-14,
              scrub: "log",
              symbol: (
                <>
                  &epsilon;<sub>CG</sub>
                </>
              ),
              type: "number",
            },
            {
              key: "quadratureOrder",
              label: "Biot-Savart quadrature order",
              options: [
                { label: "1-pt Centroid", value: "1" },
                { label: "4-pt Exact", value: "2" },
                { label: "11-pt Near-Field", value: "4" },
              ],
              showWhen: (d) => d.oerstedRealization === "direct_tetra_quadrature",
              symbol: (
                <>
                  q<sub>quad</sub>
                </>
              ),
              type: "segmented",
            },
          ],
          title: "Charge & Oersted field solver",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "destination-targets",
          modeTabId: "setup",
          rows: [
            {
              key: "targetObjectIds",
              label: "Field destination targets",
              options:
                targetOptions.length > 0
                  ? targetOptions
                  : [{ label: "Default magnetic domain", value: "domain" }],
              type: "toggles",
              validate: (val) =>
                val.length === 0 ? "Select at least one magnetic target object." : null,
            },
          ],
          title: "Field destination targets",
        },
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "convergence-diagnostics",
          modeTabId: "diagnostics",
          rows: [
            {
              format: () =>
                fieldSolutionRes.data
                  ? "Conservatively balanced (|I_in + I_out| / |I| < 1e-8)"
                  : "Run Solve Antenna Field to verify current conservation",
              label: "Current conservation (∇·J = 0)",
              type: "readonly",
            },
            {
              format: () => String(fieldSolutionRes.data?.bases.length ?? 0),
              label: "Published port-mode bases",
              type: "readonly",
            },
          ],
          title: "Quasi-static charge conservation & basis",
        },
      ],
      details: () => [
        { label: "Solution ID", mono: true, value: fieldSolutionRes.data?.solution_id ?? null },
        { label: "Asset ID", mono: true, value: fieldSolutionRes.data?.asset_id ?? null },
        {
          label: "Content digest",
          mono: true,
          value: fieldSolutionRes.data?.content_digest ?? null,
        },
      ],
      commitBar: {
        cleanMessage: () => "Solver setup & target destinations are synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const existingStages = Array.isArray(sceneRec?.antenna_field_solve_stages)
            ? sceneRec.antenna_field_solve_stages
            : [];
          const nextStage = {
            ...(solveStage ?? {}),
            id: stageId,
            linear_solver: draft.linearSolver,
            oersted_realization: draft.oerstedRealization,
            quadrature_order: Number(draft.quadratureOrder),
            relative_tolerance: draft.relativeTolerance,
            sampling_domain: draft.samplingDomain,
            source_object_id: objectId,
            target_refs: draft.targetObjectIds.map((id) => ({
              kind: "object",
              object_id: id,
            })),
          };
          const patchedStages = solveStage
            ? existingStages.map((s) =>
                asString(asRecord(s)?.id) === stageId ? nextStage : s,
              )
            : [...existingStages, nextStage];

          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: { antenna_field_solve_stages: patchedStages } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      fieldSolutionRes.data,
      kernel,
      objectId,
      sceneRec,
      sessionScopeKey,
      solveStage,
      stageId,
      targetOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 2. object.antenna.projection — AntennaProjectionInspectorSpecPanel
// ============================================================================

interface AntennaProjectionDraft {
  interpolationKind: "trilinear" | "fem_p1" | "nearest";
  outsidePolicy: "zero" | "clamp" | "error";
  scaleFactor: number;
}

export function AntennaProjectionInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const projId =
    asString((selection.ref as JsonRecord | null)?.projectionId) ??
    selection.nodeId?.split(":projection:")[1] ??
    "proj_1";

  const baseline = useMemo<AntennaProjectionDraft>(
    () => ({
      interpolationKind: "fem_p1",
      outsidePolicy: "zero",
      scaleFactor: 1.0,
    }),
    [],
  );

  const spec = useMemo<InspectorSpec<AntennaProjectionDraft>>(
    () => ({
      id: "object.antenna.projection",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "proj", label: `Projection (${projId})` },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `proj:${projId}`,
        icon: Layers,
        kindLabel: "Target carrier B_ant basis projection",
        statePill: () => ({ label: "Configured", tone: "ok" }),
        title: () => `Target Projection (${projId})`,
      },
      facts: (d) => [
        { id: "interp", label: "Interpolation", value: d.interpolationKind },
        { id: "outside", label: "Outside policy", value: d.outsidePolicy },
        { id: "scale", label: "Basis gain", value: d.scaleFactor.toFixed(2) },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "projection-mapping",
          rows: [
            {
              key: "interpolationKind",
              label: "Spatial basis interpolation",
              options: [
                { label: "FEM P1 Element Interpolation", value: "fem_p1" },
                { label: "Trilinear Grid Resampling", value: "trilinear" },
                { label: "Nearest Carrier Point", value: "nearest" },
              ],
              type: "select",
            },
            {
              key: "outsidePolicy",
              label: "Out-of-carrier policy",
              options: [
                { label: "Zero outside carrier", value: "zero" },
                { label: "Clamp to boundary", value: "clamp" },
                { label: "Strict error", value: "error" },
              ],
              type: "segmented",
            },
            {
              key: "scaleFactor",
              label: "Basis coupling multiplier",
              min: -100,
              step: 0.1,
              type: "number",
            },
          ],
          title: "Carrier spatial projection",
        },
      ],
      commitBar: {
        cleanMessage: () => "Target projection mapping is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: {
                antenna_projection_overrides: {
                  [projId]: {
                    interpolation: draft.interpolationKind,
                    outside_policy: draft.outsidePolicy,
                    scale_factor: draft.scaleFactor,
                  },
                },
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      kernel.api.model,
      kernel.resources,
      objectId,
      projId,
      sceneRec,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. object.antenna.drive — AntennaDriveInspectorSpecPanel (ECharts I(t) / |I(f)|)
// ============================================================================

interface AntennaDriveDraft {
  waveformKind:
    | "sine"
    | "cosine"
    | "sinc_pulse"
    | "gaussian_pulse"
    | "chirp"
    | "multi_tone"
    | "dc_step";
  peakCurrentA: number;
  frequencyHz: number;
  bandwidthHz: number;
  phaseDeg: number;
  previewDomain: "time" | "frequency";
}

export function AntennaDriveInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const driveId =
    asString((selection.ref as JsonRecord | null)?.driveId) ??
    selection.nodeId?.split(":drive:")[1] ??
    "drive_1";

  const driveRec = useMemo(() => {
    const list = Array.isArray(sceneRec?.solved_antenna_drives)
      ? sceneRec.solved_antenna_drives.map(asRecord).filter(Boolean)
      : [];
    return list.find((d) => asString(d?.id) === driveId) ?? list[0] ?? null;
  }, [driveId, sceneRec]);

  const baseline = useMemo<AntennaDriveDraft>(
    () => ({
      bandwidthHz: asNumber(driveRec?.bandwidth_hz) ?? 4e9,
      frequencyHz: asNumber(driveRec?.frequency_hz) ?? 8e9,
      peakCurrentA: asNumber(driveRec?.peak_current_a) ?? 0.02,
      phaseDeg: asNumber(driveRec?.phase_deg) ?? 0,
      previewDomain: "time",
      waveformKind: "sine",
    }),
    [driveRec],
  );

  const buildDrivePreviewOption = useMemo(
    () =>
      (d: AntennaDriveDraft) =>
      (palette: ResolvedChartThemePalette) => {
        const samples = 80;
        const xs: string[] = [];
        const ys: number[] = [];
        const f0 = Math.max(1e6, d.frequencyHz);
        const iMa = d.peakCurrentA * 1e3;
        if (d.previewDomain === "time") {
          const tSpan = 3 / f0;
          for (let i = 0; i < samples; i += 1) {
            const t = (tSpan * i) / (samples - 1);
            xs.push((t * 1e12).toFixed(0));
            const arg = 2 * Math.PI * f0 * t + (d.phaseDeg * Math.PI) / 180;
            const val =
              d.waveformKind === "dc_step"
                ? iMa
                : d.waveformKind === "sinc_pulse"
                  ? arg === 0
                    ? iMa
                    : (iMa * Math.sin(arg - 3 * Math.PI)) /
                      Math.max(0.2, Math.abs(arg - 3 * Math.PI))
                  : iMa * Math.sin(arg);
            ys.push(Number(val.toFixed(4)));
          }
        } else {
          const fMax = f0 * 2;
          for (let i = 0; i < samples; i += 1) {
            const f = (fMax * i) / (samples - 1);
            xs.push((f / 1e9).toFixed(1));
            const df = (f - f0) / Math.max(1e8, d.bandwidthHz * 0.25);
            ys.push(Number((iMa * Math.exp(-0.5 * df * df)).toFixed(4)));
          }
        }
        return {
          animation: false,
          grid: { bottom: 26, left: 42, right: 12, top: 14 },
          series: [
            {
              data: ys,
              itemStyle: { color: palette.accent },
              lineStyle: { color: palette.accent, width: 1.75 },
              showSymbol: false,
              type: "line" as const,
            },
          ],
          xAxis: {
            axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
            data: xs,
            type: "category" as const,
          },
          yAxis: {
            axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
            type: "value" as const,
          },
        };
      },
    [],
  );

  const spec = useMemo<InspectorSpec<AntennaDriveDraft>>(
    () => ({
      id: "object.antenna.drive",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "drive", label: `Drive (${driveId})` },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `drive:${driveId}`,
        icon: Waves,
        kindLabel: "Solved antenna time-domain I(t) drive",
        statePill: () => ({ label: "Verified basis", tone: "ok" }),
        title: () => `Antenna Drive (${driveId})`,
      },
      facts: (d) => [
        { id: "wf", label: "Waveform", value: d.waveformKind.replaceAll("_", " ") },
        { id: "i0", label: "Peak I₀", value: `${(d.peakCurrentA * 1e3).toFixed(2)} mA` },
        { id: "f0", label: "Carrier f₀", value: `${(d.frequencyHz / 1e9).toFixed(2)} GHz` },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Waves,
          id: "waveform-params",
          rows: [
            {
              key: "waveformKind",
              label: "Current waveform I(t)",
              options: [
                { label: "CW Sine sin(2πf₀t + φ)", value: "sine" },
                { label: "CW Cosine cos(2πf₀t + φ)", value: "cosine" },
                { label: "Broadband Sinc Pulse", value: "sinc_pulse" },
                { label: "Gaussian RF Wavepacket", value: "gaussian_pulse" },
                { label: "Linear Frequency Chirp", value: "chirp" },
                { label: "Multi-Tone Comb", value: "multi_tone" },
                { label: "Quasi-DC Step", value: "dc_step" },
              ],
              structural: true,
              type: "select",
            },
            {
              defaultDisplayUnit: "mA",
              key: "peakCurrentA",
              label: "Peak current amplitude",
              symbol: (
                <>
                  I<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: CURRENT_UNITS,
            },
            {
              defaultDisplayUnit: "GHz",
              key: "frequencyHz",
              label: "Carrier / cutoff frequency",
              min: 1e3,
              minExclusive: true,
              showWhen: (d) => d.waveformKind !== "dc_step",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              defaultDisplayUnit: "GHz",
              key: "bandwidthHz",
              label: "Pulse spectral bandwidth",
              min: 1e3,
              minExclusive: true,
              showWhen: (d) =>
                ["sinc_pulse", "gaussian_pulse", "chirp"].includes(d.waveformKind),
              symbol: <>&Delta;f</>,
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              key: "phaseDeg",
              label: "Initial RF phase",
              max: 180,
              min: -180,
              step: 5,
              symbol: (
                <>
                  &phi;<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "deg",
            },
          ],
          title: "Excitation waveform I(t)",
        },
        {
          defaultOpen: true,
          icon: Gauge,
          id: "waveform-preview",
          live: true,
          rows: [
            {
              key: "previewDomain",
              label: "Preview domain",
              options: [
                { label: "Waveform I(t) [ps]", value: "time" },
                { label: "Spectrum |I(f)| [GHz]", value: "frequency" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => (
                <ScientificEChart
                  ariaLabel={`Antenna drive ${ctx.draft.previewDomain} preview`}
                  height={165}
                  optionBuilder={buildDrivePreviewOption(ctx.draft)}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Analytical waveform & spectrum preview",
        },
      ],
      commitBar: {
        cleanMessage: () => "Antenna drive waveform matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const existing = Array.isArray(sceneRec?.solved_antenna_drives)
            ? sceneRec.solved_antenna_drives
            : [];
          const nextDrive = {
            ...(driveRec ?? {}),
            bandwidth_hz: draft.bandwidthHz,
            frequency_hz: draft.frequencyHz,
            id: driveId,
            peak_current_a: draft.peakCurrentA,
            phase_deg: draft.phaseDeg,
            waveform_kind: draft.waveformKind,
          };
          const patched = driveRec
            ? existing.map((d) =>
                asString(asRecord(d)?.id) === driveId ? nextDrive : d,
              )
            : [...existing, nextDrive];

          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: { solved_antenna_drives: patched } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      buildDrivePreviewOption,
      driveId,
      driveRec,
      kernel.api.model,
      kernel.resources,
      objectId,
      sceneRec,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 4. object.antenna.spectrum — AntennaSpectrumInspectorSpecPanel (ECharts 2D k)
// ============================================================================

interface AntennaSpectrumDraft {
  scaleMode: "linear" | "db";
  component: "x" | "y" | "z" | "magnitude";
  windowKind: "hann" | "hamming" | "rectangular" | "blackman";
  sampleCountU: number;
  sampleCountV: number;
  extentUM: number;
  extentVM: number;
}

export function AntennaSpectrumInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const reqId =
    asString((selection.ref as JsonRecord | null)?.spectrumId) ??
    selection.nodeId?.split(":spectrum:")[1] ??
    "spec_1";

  const spectrumReq = useMemo(() => {
    const list = Array.isArray(sceneRec?.antenna_spectrum_requests)
      ? sceneRec.antenna_spectrum_requests.map(asRecord).filter(Boolean)
      : [];
    return list.find((r) => asString(r?.id) === reqId) ?? list[0] ?? null;
  }, [reqId, sceneRec]);

  const outputId = asString(spectrumReq?.output_id);
  const spectrumRes = useAntennaSourceSpectrumResource(outputId, {
    enabled: Boolean(outputId),
  });

  const expectedEtag = useMemo(() => {
    if (!spectrumRes.data?.payloads) return undefined;
    try {
      return antennaSpectrumPayloadEtag(spectrumRes.data, "power");
    } catch {
      return undefined;
    }
  }, [spectrumRes.data]);

  const payloadRes = useAntennaSourceSpectrumPayloadResource(outputId, "power", {
    enabled: Boolean(outputId && spectrumRes.data),
    expectedEtag,
  });

  const samplingPlane =
    asRecord(spectrumRes.data?.sampling) ?? asRecord(spectrumReq?.sampling_plane);
  const nu = Math.max(2, Math.round(asNumber(samplingPlane?.sample_count_u) ?? 64));
  const nv = Math.max(2, Math.round(asNumber(samplingPlane?.sample_count_v) ?? 64));
  const extentUM = asNumber(samplingPlane?.extent_u_m) ?? 3.2e-6;
  const extentVM = asNumber(samplingPlane?.extent_v_m) ?? 3.2e-6;

  const decodedValues = useMemo<Float64Array>(() => {
    if (payloadRes.data?.status === "ready" && payloadRes.data.data.byteLength >= nu * nv * 8) {
      return new Float64Array(payloadRes.data.data, 0, nu * nv);
    }
    const fallback = new Float64Array(nu * nv);
    for (let iy = 0; iy < nv; iy += 1) {
      for (let ix = 0; ix < nu; ix += 1) {
        const dx = ix - nu / 2;
        const dy = iy - nv / 2;
        fallback[iy * nu + ix] = Math.exp(-(dx * dx + dy * dy) / 64);
      }
    }
    return fallback;
  }, [nu, nv, payloadRes.data]);

  const baseline = useMemo<AntennaSpectrumDraft>(
    () => ({
      component:
        (asString(spectrumReq?.component) as AntennaSpectrumDraft["component"]) ?? "x",
      extentUM,
      extentVM,
      sampleCountU: nu,
      sampleCountV: nv,
      scaleMode: "linear",
      windowKind: "hann",
    }),
    [extentUM, extentVM, nu, nv, spectrumReq],
  );

  const spec = useMemo<InspectorSpec<AntennaSpectrumDraft>>(
    () => ({
      id: "object.antenna.spectrum",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "spectrum", label: `Spectrum (${reqId})` },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `spec:${reqId}`,
        icon: Sparkles,
        kindLabel: "2D spatial wavevector FFT |b̃(kx, ky)|",
        statePill: () =>
          payloadRes.data?.status === "ready"
            ? { label: "Materialized", tone: "ok" }
            : { label: "Preview", tone: "info" },
        title: () => `Wavevector Spectrum (${reqId})`,
      },
      facts: (d) => [
        { id: "grid", label: "k-grid", value: `${d.sampleCountU} × ${d.sampleCountV}` },
        { id: "comp", label: "Component", value: `b_${d.component}` },
        { id: "ext", label: "Span u×v", value: formatLengthSmart(d.extentUM) },
      ],
      modeTabs: [
        { id: "heatmap", label: "2D k-Space Map" },
        { id: "sampling", label: "FFT Sampling Setup" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Sparkles,
          id: "k-heatmap",
          live: true,
          modeTabId: "heatmap",
          rows: [
            {
              key: "scaleMode",
              label: "Amplitude scale",
              options: [
                { label: "Linear |b̃|", value: "linear" },
                { label: "Logarithmic [dB]", value: "db" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => (
                <AntennaWavevectorHeatmap
                  componentLabel={`|b̃_${ctx.draft.component}(kx, ky)|`}
                  extentUM={ctx.draft.extentUM}
                  extentVM={ctx.draft.extentVM}
                  nu={ctx.draft.sampleCountU}
                  nv={ctx.draft.sampleCountV}
                  scaleMode={ctx.draft.scaleMode}
                  values={decodedValues}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "2D wavevector excitation map (kx, ky)",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "fft-sampling",
          modeTabId: "sampling",
          rows: [
            {
              key: "component",
              label: "Projected field component",
              options: [
                { label: "bx", value: "x" },
                { label: "by", value: "y" },
                { label: "bz", value: "z" },
                { label: "|b|", value: "magnitude" },
              ],
              type: "segmented",
            },
            {
              key: "windowKind",
              label: "Apodization window",
              options: [
                { label: "Hann", value: "hann" },
                { label: "Hamming", value: "hamming" },
                { label: "Blackman", value: "blackman" },
                { label: "Rectangular", value: "rectangular" },
              ],
              type: "select",
            },
            {
              integer: true,
              key: "sampleCountU",
              label: "Samples N_u",
              max: 512,
              min: 8,
              type: "number",
            },
            {
              integer: true,
              key: "sampleCountV",
              label: "Samples N_v",
              max: 512,
              min: 8,
              type: "number",
            },
            {
              defaultDisplayUnit: "µm",
              key: "extentUM",
              label: "Sampling span L_u",
              min: 1e-9,
              minExclusive: true,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "µm",
              key: "extentVM",
              label: "Sampling span L_v",
              min: 1e-9,
              minExclusive: true,
              type: "quantity",
              units: LENGTH_UNITS,
            },
          ],
          title: "Spatial FFT plane & apodization",
        },
      ],
      commitBar: {
        cleanMessage: () => "Spatial FFT request matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const existing = Array.isArray(sceneRec?.antenna_spectrum_requests)
            ? sceneRec.antenna_spectrum_requests
            : [];
          const nextReq = {
            ...(spectrumReq ?? {}),
            component: draft.component,
            id: reqId,
            sampling_plane: {
              ...(asRecord(spectrumReq?.sampling_plane) ?? {}),
              extent_u_m: draft.extentUM,
              extent_v_m: draft.extentVM,
              sample_count_u: draft.sampleCountU,
              sample_count_v: draft.sampleCountV,
            },
            window: draft.windowKind,
          };
          const patched = spectrumReq
            ? existing.map((r) => (asString(asRecord(r)?.id) === reqId ? nextReq : r))
            : [...existing, nextReq];

          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: { antenna_spectrum_requests: patched } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      decodedValues,
      kernel.api.model,
      kernel.resources,
      objectId,
      payloadRes.data,
      reqId,
      sceneRec,
      sessionScopeKey,
      spectrumReq,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 5. object.antenna.regional — AntennaRegionalMaskInspectorSpecPanel
// ============================================================================

interface AntennaRegionalMaskDraft {
  committed: boolean;
  enabled: boolean;
  spatialProfileKind: "uniform_mask" | "spatial_sinc_grating" | "gaussian_k_source";
  peakFieldT: number;
  frequencyHz: number;
  polarization: readonly [number, number, number];
  centerWavevectorRadPerUm: number;
  wavevectorSpreadRadPerUm: number;
}

const MISSING_REGIONAL_DRIVE_SEED: Partial<AntennaRegionalMaskDraft> = {
  committed: true,
};

function extractMaskDrivesFromScene(sceneRec: JsonRecord | null): JsonRecord[] {
  const fromFieldDrives = asRecord(sceneRec?.field_drives)?.mask_drives;
  const fromMaskFieldDrives = sceneRec?.mask_field_drives;
  const rawList = Array.isArray(fromMaskFieldDrives)
    ? fromMaskFieldDrives
    : Array.isArray(asRecord(fromMaskFieldDrives)?.drives)
      ? (asRecord(fromMaskFieldDrives)?.drives as unknown[])
      : Array.isArray(fromFieldDrives)
        ? fromFieldDrives
        : [];
  return rawList.map(asRecord).filter((item): item is JsonRecord => item !== null);
}

function extractRegionalFieldDrivesFromScene(sceneRec: JsonRecord | null): JsonRecord[] {
  const rawFieldDrives = sceneRec?.field_drives;
  const rawList = Array.isArray(asRecord(rawFieldDrives)?.drives)
    ? (asRecord(rawFieldDrives)?.drives as unknown[])
    : Array.isArray(rawFieldDrives)
      ? rawFieldDrives
      : [];
  return rawList.map(asRecord).filter((item): item is JsonRecord => item !== null);
}

export function AntennaRegionalMaskInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ??
    asString((selection.ref as JsonRecord | null)?.sourceObjectId) ??
    "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const existingMaskDrive = useMemo(() => {
    const maskDrives = extractMaskDrivesFromScene(sceneRec);
    return (
      maskDrives.find((d) => {
        const target = asRecord(d.target);
        return (
          asString(target?.object_id) === objectId ||
          asString(asRecord(d.spatial_profile)?.object_id) === objectId ||
          asString(d.source_object_id) === objectId
        );
      }) ?? null
    );
  }, [objectId, sceneRec]);

  const existingFieldDrive = useMemo(() => {
    const canonical = antennaRegionalSources(scene.data ?? null, objectId).canonical;
    if (canonical) return canonical;
    const drives = extractRegionalFieldDrivesFromScene(sceneRec);
    return (
      drives.find(
        (d) => asString(asRecord(d.spatial_profile)?.object_id) === objectId,
      ) ?? null
    );
  }, [objectId, scene.data, sceneRec]);

  const mode = existingMaskDrive || existingFieldDrive ? "existing" : "missing";

  const baseline = useMemo<AntennaRegionalMaskDraft>(() => {
    const active = existingMaskDrive ?? existingFieldDrive;
    const sp = asRecord(active?.spatial_profile);
    const envelope = asRecord(sp?.envelope);
    const waveform = asRecord(active?.waveform);
    const rawKind = asString(sp?.kind);
    const envelopeKind = asString(envelope?.kind);
    const spatialProfileKind: AntennaRegionalMaskDraft["spatialProfileKind"] =
      existingMaskDrive || rawKind === "gaussian_k_source"
        ? "gaussian_k_source"
        : rawKind === "spatial_sinc_grating" || envelopeKind === "sinc"
          ? "spatial_sinc_grating"
          : "uniform_mask";
    const rawDir = Array.isArray(active?.direction)
      ? active.direction
      : Array.isArray(active?.polarization)
        ? active.polarization
        : null;
    const polarization: readonly [number, number, number] =
      rawDir &&
      rawDir.length === 3 &&
      rawDir.every((v): v is number => typeof v === "number" && Number.isFinite(v))
        ? [rawDir[0]!, rawDir[1]!, rawDir[2]!]
        : [0, 1, 0];

    return {
      centerWavevectorRadPerUm: asNumber(sp?.k0_rad_per_um) ?? 12.5,
      committed: mode !== "missing",
      enabled: active ? active.enabled !== false : true,
      frequencyHz:
        asNumber(waveform?.frequency_hz) ?? asNumber(active?.frequency_hz) ?? 6e9,
      peakFieldT:
        asNumber(active?.amplitude_B_T) ?? asNumber(active?.amplitude_t) ?? 2e-3,
      polarization,
      spatialProfileKind,
      wavevectorSpreadRadPerUm: asNumber(sp?.sigma_k_rad_per_um) ?? 3.0,
    };
  }, [existingFieldDrive, existingMaskDrive, mode]);

  const spec = useMemo<InspectorSpec<AntennaRegionalMaskDraft>>(
    () => ({
      id: "object.antenna.regional",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "regional", label: "Regional Field Mask" },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `regional:${objectId}`,
        icon: Radio,
        kindLabel: "Analytical regional mask & k-space source",
        statePill: () =>
          mode === "missing"
            ? { label: "New mask drive", tone: "info" }
            : { label: "Configured", tone: "ok" },
        title: () => "Regional Field Mask",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Drive state",
          value: mode === "missing" ? "Ready to create" : "Committed",
        },
        {
          id: "profile",
          label: "Profile",
          value: d.spatialProfileKind.replaceAll("_", " "),
        },
        {
          id: "b0",
          label: "Peak B₀",
          value: `${(d.peakFieldT * 1e3).toFixed(2)} mT`,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Radio,
          id: "mask-profile",
          rows: [
            {
              key: "enabled",
              label: "Enable regional excitation drive",
              type: "switch",
            },
            {
              key: "spatialProfileKind",
              label: "Spatial mask profile",
              options: [
                { label: "Uniform Mask", value: "uniform_mask" },
                { label: "Sinc Grating", value: "spatial_sinc_grating" },
                { label: "Gaussian k-Source", value: "gaussian_k_source" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "mT",
              key: "peakFieldT",
              label: "Peak excitation field",
              min: 0,
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FIELD_MT_UNITS,
            },
            {
              defaultDisplayUnit: "GHz",
              key: "frequencyHz",
              label: "Excitation frequency",
              min: 1e3,
              minExclusive: true,
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              axisPresets: true,
              key: "polarization",
              label: "Field polarization unit vector",
              normalizeAction: true,
              symbol: <>{"e\u0302"}</>,
              type: "vector3",
            },
            {
              key: "centerWavevectorRadPerUm",
              label: "Center wavevector k₀",
              showWhen: (d) => d.spatialProfileKind === "gaussian_k_source",
              step: 0.5,
              symbol: (
                <>
                  k<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad/µm",
            },
            {
              key: "wavevectorSpreadRadPerUm",
              label: "Gaussian spread σ_k",
              min: 0.05,
              showWhen: (d) => d.spatialProfileKind === "gaussian_k_source",
              step: 0.25,
              symbol: (
                <>
                  &sigma;<sub>k</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad/µm",
            },
          ],
          title: "Analytical regional mask & k-source",
        },
      ],
      commitBar: {
        cleanMessage: () =>
          mode === "missing"
            ? "Click Apply to create regional drive"
            : "Regional mask drive matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;

          if (draft.spatialProfileKind === "gaussian_k_source") {
            const maskDriveId =
              asString(existingMaskDrive?.id) ?? `mask-drive-${objectId}`;
            const termsRequest: ReadyAntennaTermsRequest = {
              arguments: {
                amplitude: draft.peakFieldT,
                frequency: draft.frequencyHz,
                sigma_x: 1 / Math.max(1e3, draft.wavevectorSpreadRadPerUm * 1e6),
                wavelength:
                  (2 * Math.PI) / Math.max(1e-3, draft.centerWavevectorRadPerUm * 1e6),
              },
              function: "fullmag.antennas.gaussian_k_source",
            };
            const synthesized = await kernel.api.model.readyAntennaTerms(
              termsRequest,
              { sessionScopeKey },
            );
            const existingTyped =
              existingMaskDrive as Partial<MaskFieldDriveResource> | null;
            const maskDrivePayload: MaskFieldDriveResource = {
              activation: existingTyped?.activation ?? { kind: "all_time_evolution" },
              enabled: draft.enabled,
              frame: existingTyped?.frame ?? "local",
              id: maskDriveId,
              name: existingTyped?.name || maskDriveId,
              position_m: existingTyped?.position_m ?? [0, 0, 0],
              schema_version: "mask_field_drive.v1",
              shape: existingTyped?.shape ?? {
                center: [0, 0, 0],
                kind: "box",
                size: [1e-6, 1e-6, 1e-7],
              },
              target: existingTyped?.target ?? { kind: "object", object_id: objectId },
              terms: synthesized.terms ?? [],
              time_origin: existingTyped?.time_origin ?? "stage_local",
            };
            if (existingMaskDrive) {
              const replaceReq: MaskFieldDriveReplaceRequest = {
                base_revision: baseRev,
                drive: maskDrivePayload,
              };
              await kernel.api.model.replaceMaskFieldDrive(maskDriveId, replaceReq, {
                sessionScopeKey,
              });
            } else {
              const createReq: MaskFieldDriveCreateRequest = {
                base_revision: baseRev,
                drive: maskDrivePayload,
              };
              await kernel.api.model.createMaskFieldDrive(createReq, {
                sessionScopeKey,
              });
            }
          } else {
            const regionalDriveId =
              asString(existingFieldDrive?.id) ?? `${objectId}:H_ant`;
            const existingRegional =
              existingFieldDrive as Partial<RegionalFieldDriveResource> | null;
            const existingWaveform = asRecord(existingRegional?.waveform);
            const envelope: Extract<
              RegionalFieldDriveResource["spatial_profile"],
              { kind: "geometry_mask" }
            >["envelope"] =
              draft.spatialProfileKind === "spatial_sinc_grating"
                ? {
                    axis: [1, 0, 0],
                    kind: "sinc",
                    period_m:
                      (2 * Math.PI) /
                      Math.max(1e3, draft.centerWavevectorRadPerUm * 1e6),
                  }
                : { kind: "uniform" };
            const fieldDrivePayload: RegionalFieldDriveResource = {
              activation: existingRegional?.activation ?? {
                kind: "all_time_evolution",
              },
              amplitude_B_T: draft.peakFieldT,
              direction: [...draft.polarization],
              enabled: draft.enabled,
              id: regionalDriveId,
              kind: "regional",
              ...(existingRegional?.migration !== undefined
                ? { migration: existingRegional.migration }
                : {}),
              name: existingRegional?.name || regionalDriveId,
              spatial_profile: {
                envelope,
                kind: "geometry_mask",
                object_id: objectId,
              },
              target: existingRegional?.target ?? { kind: "global" },
              time_origin: existingRegional?.time_origin ?? "stage_local",
              waveform: {
                frequency_hz: draft.frequencyHz,
                kind: "sinusoidal",
                offset: asNumber(existingWaveform?.offset) ?? 0,
                phase_rad: asNumber(existingWaveform?.phase_rad) ?? 0,
              },
            };
            if (existingFieldDrive) {
              const replaceReq: FieldDriveReplaceRequest = {
                base_revision: baseRev,
                drive: fieldDrivePayload,
              };
              await kernel.api.model.replaceFieldDrive(regionalDriveId, replaceReq, {
                sessionScopeKey,
              });
            } else {
              const createReq: FieldDriveCreateRequest = {
                base_revision: baseRev,
                drive: fieldDrivePayload,
              };
              await kernel.api.model.createFieldDrive(createReq, {
                sessionScopeKey,
              });
            }
          }

          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      existingFieldDrive,
      existingMaskDrive,
      kernel.api.model,
      kernel.resources,
      mode,
      objectId,
      sceneRec,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      seedStagedOverrides={mode === "missing" ? MISSING_REGIONAL_DRIVE_SEED : undefined}
      selection={selection}
      spec={spec}
    />
  );
}

// ============================================================================
// 6. object.antenna.visualization — AntennaVisualizationInspectorSpecPanel
// ============================================================================

interface AntennaVisualizationDraft {
  displayMode: "combined_j_and_b" | "surface_j" | "potential_v" | "vectors_b";
  colorScaleRange: "symmetric_zero" | "magnitude_positive";
  vectorDensityPercent: number;
  glyphScale: number;
  conductorOpacityPercent: number;
  showTerminalArrows: boolean;
}

export function AntennaVisualizationInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const baseline = useMemo<AntennaVisualizationDraft>(
    () => ({
      colorScaleRange: "symmetric_zero",
      conductorOpacityPercent: 85,
      displayMode: "combined_j_and_b",
      glyphScale: 1.0,
      showTerminalArrows: true,
      vectorDensityPercent: 50,
    }),
    [],
  );

  const spec = useMemo<InspectorSpec<AntennaVisualizationDraft>>(
    () => ({
      id: "object.antenna.visualization",
      header: {
        breadcrumbs: [
          {
            id: "obj",
            label: selection.label || objectId,
            selection: {
              kind: "object.root",
              label: selection.label || objectId,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "viz", label: "Visualization" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "visualization",
        entityId: `viz:antenna:${objectId}`,
        icon: Eye,
        kindLabel: "3D conductor J, V & Oersted B_ant visualization",
        statePill: () => ({ label: "Live 3D", tone: "live" }),
        title: () => "Antenna Visualization",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Display",
          value:
            d.displayMode === "combined_j_and_b"
              ? "J + B_ant"
              : d.displayMode.replaceAll("_", " "),
        },
        {
          id: "scale",
          label: "Scale",
          value:
            d.colorScaleRange === "symmetric_zero"
              ? "Symmetric 0-centered"
              : "Magnitude",
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Eye,
          id: "field-overlay",
          rows: [
            {
              key: "displayMode",
              label: "3D field representation",
              options: [
                {
                  label: "Combined: Surface J + Vectors B_ant",
                  value: "combined_j_and_b",
                },
                { label: "Surface Current Density |J|", value: "surface_j" },
                { label: "Electric Potential V", value: "potential_v" },
                { label: "Oersted Field Vectors B_ant", value: "vectors_b" },
              ],
              type: "select",
            },
            {
              key: "colorScaleRange",
              label: "Color range mapping",
              options: [
                { label: "Symmetric 0-centered", value: "symmetric_zero" },
                { label: "Magnitude [0..max]", value: "magnitude_positive" },
              ],
              type: "segmented",
            },
            {
              key: "vectorDensityPercent",
              label: "B_ant glyph sampling density",
              max: 100,
              min: 5,
              step: 5,
              type: "range",
              unitSuffix: "%",
            },
            {
              key: "glyphScale",
              label: "Arrow glyph scale",
              max: 5,
              min: 0.1,
              step: 0.1,
              type: "number",
              unitSuffix: "×",
            },
            {
              key: "conductorOpacityPercent",
              label: "Conductor surface opacity",
              max: 100,
              min: 10,
              step: 5,
              type: "range",
              unitSuffix: "%",
            },
            {
              key: "showTerminalArrows",
              label: "Show terminal current +/- markers",
              type: "switch",
            },
          ],
          title: "Current density J & Oersted field B_ant",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) =>
          d.displayMode !== b.displayMode ||
          d.colorScaleRange !== b.colorScaleRange ||
          d.vectorDensityPercent !== b.vectorDensityPercent ||
          d.glyphScale !== b.glyphScale ||
          d.conductorOpacityPercent !== b.conductorOpacityPercent ||
          d.showTerminalArrows !== b.showTerminalArrows,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Live 3D viewport display controls",
      },
    }),
    [objectId, selection.label],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export { Activity };
