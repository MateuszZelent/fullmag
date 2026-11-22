"use client";

import {
  Cpu,
  Database,
  Info,
  Radar,
} from "lucide-react";
import { useContext, useMemo } from "react";

import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import {
  antennaFieldSolveDefinitionPortError,
} from "@/shared/domain/study/antennaFieldSolveCapability";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import type { StudyStageModel } from "../../../panels/StudyInspectorPanelModel";
import { antennaFieldSolvePortReferences } from "../../../panels/StudyStageAuthoringModel";
import {
  PipelineStrip,
  type PipelineStripStep,
} from "../../../panels/study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import {
  serializeStageEnabled,
  StageSpecHost,
  StudyStageTelemetryBridge,
} from "../../../panels/stages/StageSharedControls";
import { stageBreadcrumbs, resolveStageMeta, fallbackPipelineSteps } from "./stageShared";
import {
  ConnectedHysteresisChildInspectorPanel,
  resolveSelectionHysteresisView,
  StandaloneHysteresisChildInspectorPanel,
} from "./HysteresisStageSpec";
interface ChangeDeviceDraft {
  stageId: string;
  stageEnabled: boolean;
  devicePreset: "auto" | "gpu" | "cuda" | "cuda_indexed" | "cpu";
  cudaDeviceIndex: number;
}

function parseDeviceTargetDraft(raw: string | undefined): {
  devicePreset: ChangeDeviceDraft["devicePreset"];
  cudaDeviceIndex: number;
} {
  const normalized = (raw ?? "gpu").trim().toLowerCase();
  if (normalized === "cpu") return { devicePreset: "cpu", cudaDeviceIndex: 0 };
  if (normalized === "auto") return { devicePreset: "auto", cudaDeviceIndex: 0 };
  if (normalized === "cuda") return { devicePreset: "cuda", cudaDeviceIndex: 0 };
  if (normalized.startsWith("cuda:")) {
    const idxText = normalized.slice("cuda:".length);
    if (/^[0-9]+$/.test(idxText)) {
      return {
        devicePreset: "cuda_indexed",
        cudaDeviceIndex: Number.parseInt(idxText, 10),
      };
    }
  }
  return { devicePreset: "gpu", cudaDeviceIndex: 0 };
}

function serializeDeviceTargetDraft(draft: ChangeDeviceDraft): string {
  if (draft.devicePreset === "cuda_indexed") {
    return `cuda:${Math.max(0, Math.round(draft.cudaDeviceIndex || 0))}`;
  }
  return draft.devicePreset;
}

export function ChangeDeviceStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedChangeDeviceStagePanel selection={selection} />;
  }
  return <ChangeDeviceStageInspectorPanelView selection={selection} />;
}

function ConnectedChangeDeviceStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    executionProfileBound,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<ChangeDeviceDraft>(() => {
    const d =
      selectedStageDraft?.kind === "change_device" ? selectedStageDraft : null;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `change_device_${selectedStageIndex + 1}`);
    const parsed = parseDeviceTargetDraft(d?.deviceTarget ?? "cpu");
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      devicePreset: parsed.devicePreset,
      cudaDeviceIndex: parsed.cudaDeviceIndex,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <ChangeDeviceStageInspectorPanelView
          executionProfileBound={executionProfileBound}
          hydratedBaseline={hydratedBaseline}
          lastAuthoringError={lastAuthoringError}
          pipelineNodeId={selectedStageDraft?.pipelineNodeId}
          pipelineStripSteps={pipelineStripSteps}
          selection={selection}
          stageModel={selectedStageModel}
          onCommitStage={(draft) =>
            commitSelectedStageDraft(
              (base) => ({
                ...base,
                kind: "change_device",
                stageId: draft.stageId,
                stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
                deviceTarget: serializeDeviceTargetDraft(draft),
              }),
              "change_device",
            )
          }
        />
      )}
    </StudyStageTelemetryBridge>
  );
}

function ChangeDeviceStageInspectorPanelView({
  executionProfileBound = false,
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
  stageModel = null,
}: InspectorPanelProps & {
  executionProfileBound?: boolean;
  hydratedBaseline?: ChangeDeviceDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: ChangeDeviceDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  stageModel?: StudyStageModel | null;
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "change_device");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Change Device ${index + 1}`;

  const fallbackBaseline = useMemo<ChangeDeviceDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      devicePreset: "gpu",
      cudaDeviceIndex: 0,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.change_device",
            "Change device",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<ChangeDeviceDraft>>(
    () => ({
      id: "study.stage.change_device",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Cpu,
        title: () => titleLabel,
        kindLabel: "Device handoff instruction (0 s)",
        entityId: stageId,
        statePill: () =>
          executionProfileBound
            ? { tone: "warn", label: "Profile bound" }
            : { tone: "ok", label: "0 s handoff" },
      },
      facts: (d): readonly InspectorFact[] => {
        const target = serializeDeviceTargetDraft(d);
        return [
          { id: "dur", label: "Duration", value: "0 s (config)" },
          {
            id: "target",
            label: "Target device",
            value:
              target === "gpu" || target.startsWith("cuda")
                ? `${target.toUpperCase()} (strict)`
                : target.toUpperCase(),
          },
        ];
      },
      notices: () => {
        const list: InspectorNotice<ChangeDeviceDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (executionProfileBound) {
          list.push({
            id: "execution-profile-conflict",
            tone: "warn",
            text: "This Study is bound to an execution profile. Stage-level Change Device instructions conflict with profile-managed device placement.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "device-handoff",
          title: "Execution Device Transition",
          icon: Cpu,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            { key: "stageEnabled", label: "Include in study", type: "switch" },
            {
              key: "devicePreset",
              label: "Target execution device",
              type: "select",
              structural: true,
              options: [
                { value: "auto", label: "Auto" },
                { value: "gpu", label: "GPU (CUDA)" },
                { value: "cuda", label: "CUDA explicit" },
                { value: "cuda_indexed", label: "CUDA indexed (cuda:N)" },
                { value: "cpu", label: "CPU" },
              ],
            },
            {
              key: "cudaDeviceIndex",
              label: "CUDA device index",
              type: "number",
              integer: true,
              min: 0,
              max: 63,
              showWhen: (d) => d.devicePreset === "cuda_indexed",
            },
            {
              label: "Python DSL",
              type: "readonly",
              mono: true,
              format: (d) =>
                `study.stages.change_device("${serializeDeviceTargetDraft(d)}")`,
            },
            {
              label: "State transfer operator",
              type: "readonly",
              format: (d) =>
                stageModel?.transition?.transferOperator ??
                (d.devicePreset === "cpu"
                  ? "Device-to-Host exact buffer copy"
                  : "Host-to-Device exact buffer copy (strict CUDA)"),
            },
            {
              label: "Runtime transition status",
              type: "readonly",
              format: () => stageModel?.status ?? "not started",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      executionProfileBound,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      stageModel?.status,
      stageModel?.transition?.transferOperator,
      titleLabel,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}


interface AntennaFieldSolveStageDraft {
  definitionId: string;
  antennaObjectId: string;
  currentTransportId: string;
  portModeId: string;
  modelName: string;
  oerstedRealization: string;
  solverPolicy: string;
  declaredOutputs: string;
  hasDefinition: boolean;
  bound: boolean;
  errorMessage: string | null;
}

function buildAntennaFieldSolveViewDraft(
  sceneData: SceneResource | null,
  rawStage: Record<string, unknown> | null | undefined,
): AntennaFieldSolveStageDraft {
  const definitionId =
    typeof rawStage?.stage_id === "string" && rawStage.stage_id.trim()
      ? rawStage.stage_id
      : null;
  const matches = (sceneData?.antenna_field_solve_stages ?? []).filter(
    (def) => def.id === definitionId,
  );
  const definition = matches.length === 1 ? matches[0]! : null;
  const capabilityError = definition
    ? antennaFieldSolveDefinitionPortError(definition.port_mode_ids)
    : null;
  const authoredPorts = antennaFieldSolvePortReferences(
    (rawStage as JsonObject | undefined) ?? undefined,
  );
  const definitionPorts = definition
    ? antennaFieldSolvePortReferences(definition as unknown as JsonObject)
    : [];
  const effectivePorts = authoredPorts.length > 0 ? authoredPorts : definitionPorts;
  const selectedPorts = (sceneData?.antenna_port_modes ?? []).filter(
    (port) => port.id === effectivePorts[0],
  );
  const portsMatch = Boolean(
    definition &&
      effectivePorts.length === 1 &&
      definition.port_mode_ids.filter((id) => id === effectivePorts[0]).length === 1 &&
      selectedPorts.length === 1 &&
      selectedPorts[0]?.source_object_id === definition.source_object_id &&
      selectedPorts[0]?.current_transport_id === definition.current_transport_id,
  );
  const bound = Boolean(sceneData && definition && portsMatch && !capabilityError);
  const errorMessage = sceneData
    ? !definition || !portsMatch
      ? "The field-solve definition is missing, ambiguous, or its selected ports no longer match. Repair the antenna references before execution."
      : capabilityError
    : null;

  return {
    definitionId: definitionId ?? "missing explicit reference",
    antennaObjectId: definition?.source_object_id ?? "not bound",
    currentTransportId: definition?.current_transport_id ?? "not bound",
    portModeId: effectivePorts.join(", ") || "none",
    modelName: definition?.model ?? "not bound",
    oerstedRealization: definition?.oersted_realization ?? "not bound",
    solverPolicy: definition?.solver_policy ?? "not bound",
    declaredOutputs:
      definition?.outputs.map((o) => `${o.id}: ${o.quantity}`).join(", ") || "none",
    hasDefinition: Boolean(definition),
    bound,
    errorMessage,
  };
}

export function AntennaFieldSolveStageInspectorPanel({
  rawStagePayload,
  sceneOverride,
  selection,
}: InspectorPanelProps & {
  rawStagePayload?: Record<string, unknown>;
  sceneOverride?: SceneResource | null;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && sceneOverride === undefined && !rawStagePayload) {
    return <ConnectedAntennaFieldSolveStagePanel selection={selection} />;
  }
  return (
    <AntennaFieldSolveStageInspectorPanelView
      hydratedBaseline={buildAntennaFieldSolveViewDraft(
        sceneOverride ?? null,
        rawStagePayload,
      )}
      selection={selection}
    />
  );
}

function ConnectedAntennaFieldSolveStagePanel({
  selection,
}: InspectorPanelProps) {
  const { pipelineStripSteps, sceneData, selectedStageDraft } =
    useKernelStudyAuthoring(selection);
  const hydratedBaseline = useMemo(
    () =>
      buildAntennaFieldSolveViewDraft(
        sceneData,
        selectedStageDraft?.rawStage as Record<string, unknown> | undefined,
      ),
    [sceneData, selectedStageDraft?.rawStage],
  );

  return (
    <AntennaFieldSolveStageInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
    />
  );
}

function AntennaFieldSolveStageInspectorPanelView({
  hydratedBaseline,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  hydratedBaseline: AntennaFieldSolveStageDraft;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId } = resolveStageMeta(selection, "antenna_field_solve");
  const titleLabel = `Antenna Field Solve ${index + 1}`;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.antenna_field_solve",
            "Antenna field solve",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<AntennaFieldSolveStageDraft>>(
    () => ({
      id: "study.stage.antenna_field_solve",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Radar,
        title: () => titleLabel,
        kindLabel: "Antenna Oersted pre-solve stage",
        entityId: stageId,
        statePill: (d) =>
          !d.hasDefinition
            ? { tone: "err", label: "Unbound" }
            : d.errorMessage
              ? { tone: "err", label: "Invalid ref" }
              : d.bound
                ? { tone: "ok", label: "Bound" }
                : { tone: "warn", label: "Unbound" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "ant", label: "Antenna", value: d.antennaObjectId },
        { id: "port", label: "Port mode", value: d.portModeId },
        { id: "real", label: "Realization", value: d.oerstedRealization },
      ],
      notices: (d) => [
        ...(d.errorMessage
          ? [{ id: "ant-err", tone: "err" as const, text: d.errorMessage }]
          : []),
        {
          id: "ant-qualification-note",
          tone: "warn" as const,
          text: "A declared stage or output is not a solved field or physical qualification. Preparation, source ownership, and result integrity must pass before using V/J/H.",
        },
      ],
      sections: [
        {
          id: "antenna-binding",
          title: "Referenced Antenna Definition",
          icon: Radar,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              label: "Definition ID",
              type: "readonly",
              mono: true,
              format: (d) => d.definitionId,
            },
            {
              label: "Source object ID",
              type: "readonly",
              mono: true,
              format: (d) => d.antennaObjectId,
            },
            {
              label: "Current transport ID",
              type: "readonly",
              mono: true,
              format: (d) => d.currentTransportId,
            },
            {
              label: "Selected port IDs",
              type: "readonly",
              mono: true,
              format: (d) => d.portModeId,
            },
            {
              label: "Model",
              type: "readonly",
              mono: true,
              format: (d) => d.modelName,
            },
            {
              label: "Oersted realization",
              type: "readonly",
              mono: true,
              format: (d) => d.oerstedRealization,
            },
            {
              label: "Solver policy",
              type: "readonly",
              format: (d) => d.solverPolicy,
            },
            {
              label: "Declared outputs",
              type: "readonly",
              mono: true,
              format: (d) => d.declaredOutputs,
            },
            {
              label: "Parameter owner",
              type: "readonly",
              format: () =>
                "Antenna → field-solve definition / current transport / ports",
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Edit conductor geometry and port excitation on the Antenna object node",
      },
    }),
    [index, resolvedSteps, stageId, titleLabel],
  );

  return (
    <StageSpecHost
      baseline={hydratedBaseline}
      selection={selection}
      spec={spec}
    />
  );
}


interface ActionFallbackDraft {
  stageId: string;
  originalKind: string;
  preservedJson: string;
}

export function ActionStageFallbackInspectorPanel({
  rawStagePayload,
  selection,
}: InspectorPanelProps & {
  rawStagePayload?: Record<string, unknown>;
}) {
  const kernel = useContext(KernelContext);
  const hysteresisView = resolveSelectionHysteresisView(selection);

  if (hysteresisView !== "overview") {
    if (kernel) {
      return (
        <ConnectedHysteresisChildInspectorPanel
          selection={selection}
          view={hysteresisView}
        />
      );
    }
    return (
      <StandaloneHysteresisChildInspectorPanel
        selection={selection}
        view={hysteresisView}
      />
    );
  }

  if (kernel && !rawStagePayload) {
    return <ConnectedActionStageFallbackPanel selection={selection} />;
  }
  return (
    <ActionStageFallbackInspectorPanelView
      rawStagePayload={rawStagePayload}
      selection={selection}
    />
  );
}

function ConnectedActionStageFallbackPanel({ selection }: InspectorPanelProps) {
  const { selectedStageDraft } = useKernelStudyAuthoring(selection);
  const { stageId: fallbackId } = resolveStageMeta(selection, "action");
  const stageId = selectedStageDraft?.stageId || fallbackId;
  const raw = selectedStageDraft?.rawStage as Record<string, unknown> | undefined;
  const originalKind =
    typeof raw?.kind === "string" && raw.kind.trim()
      ? raw.kind
      : selectedStageDraft?.kind && selectedStageDraft.kind !== "unsupported"
        ? selectedStageDraft.kind
        : "not declared";
  const hydratedBaseline = useMemo<ActionFallbackDraft>(
    () => ({
      stageId,
      originalKind,
      preservedJson: JSON.stringify(
        raw ?? {
          stage_id: stageId,
          kind: originalKind === "not declared" ? "pipeline_instruction" : originalKind,
        },
        null,
        2,
      ),
    }),
    [originalKind, raw, stageId],
  );
  return (
    <ActionStageFallbackInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      selection={selection}
    />
  );
}

function ActionStageFallbackInspectorPanelView({
  hydratedBaseline,
  rawStagePayload,
  selection,
}: InspectorPanelProps & {
  hydratedBaseline?: ActionFallbackDraft;
  rawStagePayload?: Record<string, unknown>;
}) {
  const { index, stageId } = resolveStageMeta(selection, "action");
  const titleLabel = selection.label ?? `Pipeline Action ${index + 1}`;
  const rawKind =
    typeof rawStagePayload?.kind === "string" && rawStagePayload.kind.trim()
      ? rawStagePayload.kind
      : "not declared";

  const fallbackBaseline = useMemo<ActionFallbackDraft>(
    () => ({
      stageId,
      originalKind: rawKind,
      preservedJson: JSON.stringify(
        rawStagePayload ?? { stage_id: stageId, kind: "pipeline_instruction" },
        null,
        2,
      ),
    }),
    [rawKind, rawStagePayload, stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const spec = useMemo<InspectorSpec<ActionFallbackDraft>>(
    () => ({
      id: "study.stage.action",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Info,
        title: () => titleLabel,
        kindLabel: "Preserved pipeline instruction",
        entityId: stageId,
        statePill: () => ({ tone: "info", label: "Preserved" }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "id", label: "Stage ID", value: d.stageId },
        { id: "kind", label: "Original kind", value: d.originalKind },
        { id: "mode", label: "Authoring", value: "Lossless read-only" },
      ],
      notices: () => [
        {
          id: "preserved-info",
          tone: "warn",
          text: "This stage kind is not editable in the current inspector. Fullmag preserves its original payload losslessly and will not reinterpret it as another physical instruction.",
        },
      ],
      sections: [
        {
          id: "unsupported-meta",
          title: "Unsupported Stage",
          icon: Info,
          defaultOpen: true,
          rows: [
            {
              label: "Original kind",
              type: "readonly",
              mono: true,
              format: (d) => d.originalKind,
            },
            {
              label: "Editing",
              type: "readonly",
              format: () => "Disabled to prevent semantic drift",
            },
            {
              label: "Round-trip",
              type: "readonly",
              format: () => "Original payload preserved",
            },
          ],
        },
        {
          id: "preserved-payload",
          title: "Preserved payload",
          icon: Database,
          defaultOpen: false,
          rows: [
            {
              label: "IR payload",
              type: "readonly",
              mono: true,
              format: (d) => d.preservedJson,
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Preserved pipeline instruction",
      },
    }),
    [stageId, titleLabel],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}
