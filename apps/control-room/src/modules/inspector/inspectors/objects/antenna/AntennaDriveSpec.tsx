"use client";

import {
  Gauge,
  Link2,
  Waves,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { JsonObject } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { antennaResourceOwner } from "@/shared/domain/physics/antennaResourceOwner";
import { Input } from "@/shared/ui/Input";
import { Slider } from "@/shared/ui/Slider";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FeedbackBanner } from "../../../primitives/FeedbackBanner";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorPropertyRow } from "../../../primitives/InspectorPropertyRow";
import type { InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  antennaDriveBindingKey,
  antennaDriveBindingOptions,
  validateAntennaDriveBinding,
} from "../../../panels/antenna/AntennaDriveBindingsModel";
import {
  defaultDrivePreviewRange,
  MAX_DRIVE_PREVIEW_POINTS,
  sampleAntennaDrive,
} from "../../../panels/antenna/AntennaDrivePreviewModel";
import { RadixRelatedResources } from "../../../panels/antenna/AntennaExcitationComposers";
import { AntennaPiecewisePointsEditor } from "../../../panels/antenna/AntennaPiecewisePointsEditor";
import { convertRfPortLevel } from "../../../panels/antenna/rfPowerConverter";
import {
  antennaRunStageOptions,
  buildSolvedDrive,
  changeSolvedDriveWaveformKind,
  solvedDriveDraft,
  type SolvedDrive,
  type WaveformKind,
} from "../../../panels/antenna/SolvedAntennaDriveEditorModel";
import {
  type AntennaDriveSpecDraft,
  asNumber,
  asRecord,
  asString,
  canonicalResourceSelection,
  coerceCanonicalSolvedDrive,
  CURRENT_UNITS,
  executeAntennaMergePatchTransaction,
  FREQUENCY_UNITS,
  resolveSelectedAntennaResourceId,
  resolveSelectedObjectId,
  TIME_UNITS,
  toModelSolvedDriveDraft,
} from "./antennaExcitationShared";

export function AntennaDriveInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedDriveId = resolveSelectedAntennaResourceId(
    selection,
    "driveId",
    ":drive:",
  );

  const rawDriveRec = useMemo(() => {
    const list = Array.isArray(sceneRec?.solved_antenna_drives)
      ? sceneRec.solved_antenna_drives.map(asRecord).filter(Boolean)
      : [];
    if (requestedDriveId) {
      return list.find((d) => asString(d?.id) === requestedDriveId) ?? null;
    }
    return (
      list.find((d) => {
        const id = asString(d?.id);
        return (
          Boolean(id) &&
          Boolean(scene.data) &&
          antennaResourceOwner(scene.data!, "drive", id!) === objectId
        );
      }) ??
      list[0] ??
      null
    );
  }, [objectId, requestedDriveId, scene.data, sceneRec]);

  const driveId =
    asString(rawDriveRec?.id) ?? requestedDriveId ?? "drive_1";

  const canonicalDrive = useMemo(
    () => coerceCanonicalSolvedDrive(rawDriveRec, driveId, objectId),
    [driveId, objectId, rawDriveRec],
  );

  const bindingOptions = useMemo(
    () => antennaDriveBindingOptions(scene.data, canonicalDrive),
    [canonicalDrive, scene.data],
  );
  const runStageOptions = useMemo(
    () => antennaRunStageOptions(scene.data),
    [scene.data],
  );

  const baseline = useMemo<AntennaDriveSpecDraft>(() => {
    const sd = solvedDriveDraft(canonicalDrive);
    return {
      activationKind: sd.activationKind,
      bandwidthHz: sd.bandwidthHz,
      bindingKey: antennaDriveBindingKey(sd.projectionRef, sd.portModeId),
      cutoffHz: Number(sd.cutoffHz) || 20e9,
      frequencyHz: Number(sd.frequencyHz) || 8e9,
      name: sd.name,
      offset: Number(sd.offset) || 0,
      peakCurrentA: Number(sd.peakCurrentA) || 0.02,
      phaseRad: Number(sd.phaseRad) || 0,
      piecewisePoints: sd.piecewisePoints,
      previewDomain: "time",
      pulseOff: Number(sd.pulseOff) || 1e-9,
      pulseOn: Number(sd.pulseOn) || 0,
      sincAmplitude: Number(sd.sincAmplitude) || 1,
      sincT0: Number(sd.sincT0) || 5e-11,
      stageIdsList: sd.stageIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      timeOrigin: sd.timeOrigin,
      waveformKind: sd.waveformKind,
    };
  }, [canonicalDrive]);

  const [previewRangeState, setPreviewRangeState] = useState<{
    driveId: string;
    from: string;
    to: string;
  } | null>(null);
  const [sampleCursor, setSampleCursor] = useState(0);

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "drive", driveId),
    [driveId, objectId, selection],
  );

  const selectBindingOptions = useMemo(() => {
    const items = bindingOptions.map((opt) => ({
      label: opt.label,
      value: opt.key,
    }));
    if (!items.some((i) => i.value === baseline.bindingKey)) {
      items.unshift({
        label: `${canonicalDrive.projection_ref} / ${canonicalDrive.port_mode_id}`,
        value: baseline.bindingKey,
      });
    }
    return items;
  }, [
    baseline.bindingKey,
    bindingOptions,
    canonicalDrive.port_mode_id,
    canonicalDrive.projection_ref,
  ]);

  const handleDriveFieldChange = useCallback(
    <K extends keyof AntennaDriveSpecDraft & string>(
      key: K,
      value: AntennaDriveSpecDraft[K],
      helpers: {
        draft: AntennaDriveSpecDraft;
        patchDraft: (partial: Partial<AntennaDriveSpecDraft>) => void;
      },
    ) => {
      if (key === "waveformKind") {
        const currentModel = toModelSolvedDriveDraft(
          helpers.draft,
          canonicalDrive.projection_ref,
          canonicalDrive.port_mode_id,
        );
        const switched = changeSolvedDriveWaveformKind(
          currentModel,
          value as WaveformKind,
        );
        helpers.patchDraft({
          bandwidthHz: switched.bandwidthHz,
          cutoffHz: Number(switched.cutoffHz),
          frequencyHz: Number(switched.frequencyHz),
          offset: Number(switched.offset),
          phaseRad: Number(switched.phaseRad),
          piecewisePoints: switched.piecewisePoints,
          pulseOff: Number(switched.pulseOff),
          pulseOn: Number(switched.pulseOn),
          sincAmplitude: Number(switched.sincAmplitude),
          sincT0: Number(switched.sincT0),
        });
      }
    },
    [canonicalDrive.port_mode_id, canonicalDrive.projection_ref],
  );

  const spec = useMemo<InspectorSpec<AntennaDriveSpecDraft>>(
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
        deleteAction: rawDriveRec
          ? {
              confirmDescription:
                "Removes this solved antenna current drive without deleting its projection or port.",
              confirmTitle: (d) => `Remove drive ${d.name || driveId}?`,
              label: "Remove drive (no cascade)",
              onDelete: async () => {
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                const remaining = (
                  Array.isArray(sceneRec?.solved_antenna_drives)
                    ? sceneRec.solved_antenna_drives
                    : []
                ).filter((item) => asString(asRecord(item)?.id) !== driveId);
                await executeAntennaMergePatchTransaction({
                  baseRevision: baseRev,
                  kernel,
                  label: `Remove antenna drive ${driveId}`,
                  mergePatch: {
                    solved_antenna_drives: remaining as JsonObject[],
                  },
                  scene: scene.data ?? null,
                  sessionScopeKey,
                });
              },
            }
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `drive:${driveId}`,
        icon: Waves,
        kindLabel: "Solved antenna time-domain I(t) drive",
        renameFieldKey: "name",
        statePill: () => ({ label: "Configured", tone: "ok" }),
        title: (d) => d.name || `Antenna Drive (${driveId})`,
      },
      facts: (d) => {
        const rfConv = convertRfPortLevel({
          mode: "current_a",
          value: Math.abs(d.peakCurrentA),
          z0Ohm: 50,
        });
        return [
          {
            id: "wf",
            label: "Waveform",
            value: d.waveformKind.replaceAll("_", " "),
          },
          {
            id: "i0",
            label: "Peak I₀",
            value: `${(d.peakCurrentA * 1e3).toFixed(2)} mA`,
          },
          {
            id: "dbm",
            label: "50 Ω CW eq.",
            value: Number.isFinite(rfConv.powerDbm)
              ? `${rfConv.powerDbm >= 0 ? "+" : ""}${rfConv.powerDbm.toFixed(1)} dBm`
              : "0 mW",
          },
        ];
      },
      sections: [
        {
          defaultOpen: true,
          icon: Waves,
          id: "waveform-params",
          rows: [
            {
              key: "name",
              label: "Drive name",
              type: "text",
              validate: (v) =>
                !v.trim() ? "Drive name is required." : null,
            },
            {
              key: "bindingKey",
              label: "Field projection and port",
              options: selectBindingOptions,
              type: "select",
            },
            {
              defaultDisplayUnit: "mA",
              key: "peakCurrentA",
              label: "Peak current scale",
              symbol: (
                <>
                  I<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: CURRENT_UNITS,
            },
            {
              format: (d) => {
                const conv = convertRfPortLevel({
                  mode: "current_a",
                  value: Math.abs(d.peakCurrentA),
                  z0Ohm: 50,
                });
                return Number.isFinite(conv.powerDbm)
                  ? `${conv.powerDbm >= 0 ? "+" : ""}${conv.powerDbm.toFixed(2)} dBm (${conv.powerMw.toFixed(2)} mW · ${conv.peakVoltageV.toFixed(3)} V peak @ 50 Ω)`
                  : "0 mW @ 50 Ω";
              },
              label: "50 Ω RF power equivalent",
              type: "readonly",
            },
            {
              key: "waveformKind",
              label: "Waveform",
              options: [
                { label: "Constant", value: "constant" },
                { label: "Sinusoidal", value: "sinusoidal" },
                { label: "Sinc pulse", value: "sinc_pulse" },
                { label: "Pulse", value: "pulse" },
                { label: "Piecewise linear", value: "piecewise_linear" },
              ],
              structural: true,
              type: "select",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "frequencyHz",
              label: "Frequency",
              min: 1e-6,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinusoidal",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              key: "phaseRad",
              label: "Phase",
              showWhen: (d) => d.waveformKind === "sinusoidal",
              step: 0.1,
              symbol: (
                <>
                  &phi;<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad",
            },
            {
              key: "offset",
              label: "Offset",
              showWhen: (d) => d.waveformKind === "sinusoidal",
              step: 0.05,
              type: "number",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "cutoffHz",
              label: "Cutoff frequency",
              min: 1e-6,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              defaultDisplayUnit: "ps",
              key: "sincT0",
              label: "Center time t₀",
              min: 0,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS,
            },
            {
              key: "sincAmplitude",
              label: "Sinc amplitude",
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              step: 0.1,
              type: "number",
            },
            {
              defaultDisplayUnit: "ns",
              key: "pulseOn",
              label: "Pulse on t_on",
              showWhen: (d) => d.waveformKind === "pulse",
              type: "quantity",
              units: TIME_UNITS,
            },
            {
              defaultDisplayUnit: "ns",
              key: "pulseOff",
              label: "Pulse off t_off",
              showWhen: (d) => d.waveformKind === "pulse",
              type: "quantity",
              units: TIME_UNITS,
              validate: (v, d) =>
                d.waveformKind === "pulse" && v <= d.pulseOn
                  ? "Pulse requires t_off > t_on."
                  : null,
            },
            {
              render: (ctx) => (
                <AntennaPiecewisePointsEditor
                  value={ctx.draft.piecewisePoints}
                  onChange={(pts) => ctx.setField("piecewisePoints", pts)}
                />
              ),
              showWhen: (d) => d.waveformKind === "piecewise_linear",
              type: "custom",
              wide: true,
            },
            {
              hint: "Optional physical upper frequency in Hz; leave blank when undeclared.",
              key: "bandwidthHz",
              label: "Declared bandwidth [Hz]",
              mono: true,
              placeholder: "Optional f_max [Hz]",
              showWhen: (d) =>
                d.waveformKind === "pulse" ||
                d.waveformKind === "piecewise_linear",
              type: "text",
            },
            {
              key: "timeOrigin",
              label: "Time origin",
              options: [
                { label: "Stage-local waveform time", value: "stage_local" },
                { label: "Absolute simulation time", value: "absolute" },
              ],
              type: "segmented",
            },
            {
              key: "activationKind",
              label: "Activation",
              options: [
                {
                  label: "All time-evolution stages",
                  value: "all_time_evolution",
                },
                { label: "Selected Run stages", value: "stage_ids" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "stageIdsList",
              label: "Active Run stages",
              options:
                runStageOptions.length > 0
                  ? runStageOptions.map((o) => ({ label: o.label, value: o.id }))
                  : [{ label: "No enabled Run stages", value: "__empty__" }],
              showWhen: (d) => d.activationKind === "stage_ids",
              type: "toggles",
              validate: (val, d) =>
                d.activationKind === "stage_ids" &&
                val.filter((x) => x !== "__empty__").length === 0
                  ? "Select at least one enabled Run stage."
                  : null,
            },
          ],
          title: "Excitation drive authoring",
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
                { label: "Waveform I(t)", value: "time" },
                { label: "Spectrum |I(f)| [GHz]", value: "frequency" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => {
                let candidateDrive: SolvedDrive | null = null;
                let sampleError: string | null = null;
                try {
                  candidateDrive = buildSolvedDrive(
                    canonicalDrive,
                    toModelSolvedDriveDraft(
                      ctx.draft,
                      canonicalDrive.projection_ref,
                      canonicalDrive.port_mode_id,
                    ),
                  );
                } catch (err) {
                  sampleError =
                    err instanceof Error ? err.message : String(err);
                }
                const defaults = candidateDrive
                  ? defaultDrivePreviewRange(candidateDrive)
                  : ([0, 1e-9] as const);
                const activeRange =
                  previewRangeState?.driveId === driveId
                    ? previewRangeState
                    : null;
                const fromText = activeRange
                  ? activeRange.from
                  : String(defaults[0]);
                const toText = activeRange
                  ? activeRange.to
                  : String(defaults[1]);

                let sampledPoints: Array<{ x: number; y: number }> = [];
                if (candidateDrive && !sampleError) {
                  try {
                    sampledPoints = sampleAntennaDrive(
                      candidateDrive,
                      Number(fromText),
                      Number(toText),
                    );
                  } catch (err) {
                    sampleError =
                      err instanceof Error ? err.message : String(err);
                  }
                }
                const clampedIndex = Math.min(
                  sampleCursor,
                  Math.max(0, sampledPoints.length - 1),
                );
                const activeSample = sampledPoints[clampedIndex] ?? null;

                const optionBuilder = (palette: ResolvedChartThemePalette) => {
                  if (ctx.draft.previewDomain === "frequency") {
                    const f0 =
                      ctx.draft.waveformKind === "sinc_pulse"
                        ? Math.max(1e6, ctx.draft.cutoffHz)
                        : Math.max(1e6, ctx.draft.frequencyHz);
                    const xs: string[] = [];
                    const ys: number[] = [];
                    const iMa = Math.abs(ctx.draft.peakCurrentA) * 1e3;
                    for (let i = 0; i < 80; i += 1) {
                      const f = (2 * f0 * i) / 79;
                      xs.push((f / 1e9).toFixed(2));
                      const val =
                        ctx.draft.waveformKind === "sinc_pulse"
                          ? f <= f0
                            ? iMa * Math.abs(ctx.draft.sincAmplitude)
                            : 0
                          : ctx.draft.waveformKind === "constant"
                            ? i === 0
                              ? iMa
                              : 0
                            : iMa *
                              Math.exp(
                                -0.5 * Math.pow((f - f0) / (0.12 * f0), 2),
                              );
                      ys.push(Number(val.toFixed(4)));
                    }
                    return {
                      animation: false,
                      grid: { bottom: 26, left: 44, right: 12, top: 14 },
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
                        axisLabel: {
                          color: palette.textMuted,
                          fontSize: palette.fontSize,
                        },
                        data: xs,
                        type: "category" as const,
                      },
                      yAxis: {
                        axisLabel: {
                          color: palette.textMuted,
                          fontSize: palette.fontSize,
                        },
                        splitLine: { lineStyle: { color: palette.borderSubtle } },
                        type: "value" as const,
                      },
                    };
                  }
                  const xs = sampledPoints.map((pt) =>
                    (pt.x * 1e12).toFixed(1),
                  );
                  const ys = sampledPoints.map((pt) =>
                    Number((pt.y * 1e3).toFixed(5)),
                  );
                  return {
                    animation: false,
                    grid: { bottom: 26, left: 44, right: 12, top: 14 },
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
                      axisLabel: {
                        color: palette.textMuted,
                        fontSize: palette.fontSize,
                      },
                      data: xs,
                      type: "category" as const,
                    },
                    yAxis: {
                      axisLabel: {
                        color: palette.textMuted,
                        fontSize: palette.fontSize,
                      },
                      splitLine: { lineStyle: { color: palette.borderSubtle } },
                      type: "value" as const,
                    },
                  };
                };

                return (
                  <div
                    className="fm-inspector-stack"
                    data-testid="antenna-drive-preview"
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <InspectorPropertyRow
                        label="Preview from [s]"
                        layout="stacked"
                      >
                        <Input
                          aria-label="Preview from"
                          inputMode="decimal"
                          value={fromText}
                          onChange={(e) =>
                            setPreviewRangeState({
                              driveId,
                              from: e.currentTarget.value,
                              to: toText,
                            })
                          }
                        />
                      </InspectorPropertyRow>
                      <InspectorPropertyRow
                        label="Preview to [s]"
                        layout="stacked"
                      >
                        <Input
                          aria-label="Preview to"
                          inputMode="decimal"
                          value={toText}
                          onChange={(e) =>
                            setPreviewRangeState({
                              driveId,
                              from: fromText,
                              to: e.currentTarget.value,
                            })
                          }
                        />
                      </InspectorPropertyRow>
                    </div>
                    <ScientificEChart
                      ariaLabel={`Antenna drive ${ctx.draft.previewDomain} preview`}
                      height={165}
                      optionBuilder={optionBuilder}
                    />
                    <InspectorPropertyRow
                      label={`Sample scrubber (${sampledPoints.length} / ${MAX_DRIVE_PREVIEW_POINTS})`}
                      layout="stacked"
                    >
                      <Slider
                        aria-label="Preview sample"
                        disabled={sampledPoints.length === 0}
                        max={Math.max(1, sampledPoints.length - 1)}
                        min={0}
                        step={1}
                        value={[clampedIndex]}
                        onValueChange={(vals) => setSampleCursor(vals[0] ?? 0)}
                      />
                    </InspectorPropertyRow>
                    <FieldRow
                      label="Sample time"
                      mono
                      value={
                        activeSample
                          ? `${activeSample.x.toExponential(6)} s`
                          : "—"
                      }
                    />
                    <FieldRow
                      label="Sample current"
                      mono
                      value={
                        activeSample
                          ? `${activeSample.y.toExponential(6)} A`
                          : "—"
                      }
                    />
                    {sampleError ? (
                      <FeedbackBanner kind="warning" message={sampleError} />
                    ) : null}
                  </div>
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          title: "Analytical waveform preview & sample scrubber",
        },
        {
          defaultOpen: false,
          icon: Link2,
          id: "related-resources",
          live: true,
          rows: [
            {
              render: () => (
                <RadixRelatedResources
                  available={scene.status === "ready"}
                  scene={scene.data ?? null}
                  scope={scene.sessionScopeKey ?? scope}
                  selection={relatedSelection}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Related antenna resources",
        },
      ],
      commitBar: {
        cleanMessage: () => "Antenna drive waveform matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const modelDraft = toModelSolvedDriveDraft(
            draft,
            canonicalDrive.projection_ref,
            canonicalDrive.port_mode_id,
          );
          const updatedDrive = buildSolvedDrive(canonicalDrive, modelDraft);
          if (
            scene.data?.antenna_target_projections?.length &&
            scene.data?.antenna_port_modes?.length
          ) {
            validateAntennaDriveBinding(
              scene.data,
              canonicalDrive,
              updatedDrive,
            );
          }
          const existing = Array.isArray(sceneRec?.solved_antenna_drives)
            ? sceneRec.solved_antenna_drives
            : [];
          const patched = rawDriveRec
            ? existing.map((d) =>
                asString(asRecord(d)?.id) === driveId ? updatedDrive : d,
              )
            : [...existing, updatedDrive];

          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna drive ${driveId}`,
            mergePatch: {
              solved_antenna_drives: patched as unknown as JsonObject[],
            },
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      canonicalDrive,
      driveId,
      kernel,
      objectId,
      previewRangeState,
      rawDriveRec,
      relatedSelection,
      runStageOptions,
      sampleCursor,
      scene.data,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      selectBindingOptions,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleDriveFieldChange}
    />
  );
}
