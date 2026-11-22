"use client";

import {
  Activity,
  Box,
  Clock,
  Database,
  Download,
  ExternalLink,
  FileOutput,
  Gauge,
  GitCommit,
  History,
  Layers,
  Pin,
  PinOff,
  Sigma,
  Table2,
} from "lucide-react";
import { useCallback, useContext, useMemo } from "react";

import type { AnalysisNodeKind } from "@/kernel/analysis-modules/analysisModuleContract";
import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import { UNPIN_POSTPROCESSING_DEFINITION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import type { MaterializedDatasetResource, PostprocessingDefinition } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import {
  useObservationFrameListResource,
  useObservationFrameResource,
} from "@/kernel/resources/observationFrameResources";
import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";
import {
  sessionResourceIdentityFromStatus,
  type SessionResourceIdentity,
} from "@/kernel/resources/sessionResourceIdentity";
import { useMaterializedDatasetResource } from "@/kernel/resources/solutionSetResources";
import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionResourceIdentity,
} from "@/kernel/resources/useSessionStatus";
import {
  materializedDatasetSelectionMatches,
  returnToCurrentFieldView,
} from "@/kernel/visualization/savedFieldPresentation";
import { useSavedFieldPresentation } from "@/kernel/visualization/useObjectVisualization";
import {
  observationSourceWorkspaceStore,
  pinnedObservationSourceEquals,
  pinnedObservationSourceFromFrame,
} from "@/kernel/workspace/observationSourceWorkspace";
import { useObservationSourceWorkspaceSelector } from "@/kernel/workspace/useObservationSourceWorkspace";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { FrequencyDomainExportsInspectorPanel } from "../frequency-domain/FrequencyDomainResultInspectors";
import {
  materializedDatasetSelection,
  materializedDatasetSelectionMatchesProject,
} from "../MaterializedDatasetInspectorPanel.model";
import { MaterializedDatasetValues } from "../MaterializedDatasetValues";
import { SavedFieldVisualizationPanel } from "../SavedFieldVisualizationPanel";
import { savedFieldPresentationForDataset } from "../SavedFieldVisualizationPanel.model";
import { ConnectedInspectorSpec } from "../study/ConnectedInspectorSpec";
import {
  analysisViewInspectorModel,
  derivedValueInspectorModel,
  exportInspectorModel,
  tableInspectorModel,
  type PostprocessingInspectorModel,
} from "./postprocessingInspectorModel";

interface EmptyPostprocessingDraft {
  componentIndex: string;
}

const DEFAULT_POSTPROCESSING_DRAFT: EmptyPostprocessingDraft = {
  componentIndex: "0",
};

const LEGACY_UNPUBLISHED_TOKEN_RE = /^(?:unavail\w*|unkn\w*|n\/a)$/i;

function sanitizePlaceholderText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const trimmed = value.trim();
  if (!trimmed || LEGACY_UNPUBLISHED_TOKEN_RE.test(trimmed)) {
    return "—";
  }
  return value;
}

function scopeForPostprocessingSelection(
  selection: InspectorPanelProps["selection"],
): "definition" | "root" {
  return selection.ref?.type === "postprocessing"
    ? selection.ref.scope
    : selection.kind?.endsWith(".root")
      ? "root"
      : "definition";
}

function copyTextArtifact(payload: string): void {
  void navigator.clipboard?.writeText(payload).catch(() => undefined);
}

function PostprocessingModelInspectorView({
  emptyDescription,
  emptyTitle,
  hostFrequencyDomainExports = false,
  icon,
  idPrefix,
  model,
  scope,
  selection,
}: {
  emptyDescription?: string;
  emptyTitle?: string;
  hostFrequencyDomainExports?: boolean;
  icon: InspectorSpec<EmptyPostprocessingDraft>["identity"]["icon"];
  idPrefix: string;
  model: PostprocessingInspectorModel;
  scope: "definition" | "root";
  selection: InspectorPanelProps["selection"];
}) {
  const kernel = useContext(KernelContext);
  const postRef = selection.ref?.type === "postprocessing" ? selection.ref : null;
  const fdRef = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const isPublished = model.status.availability === "available";

  const openInAnalysis = useCallback(() => {
    kernel?.layout?.setActiveViewportMainModule?.("analysis-plots");
    kernel?.layout?.setFocusedSlot?.("viewport-main");
    if (kernel) {
      void kernel.commands.execute(
        "workspace.focus-selection",
        createCommandContext("inspector", kernel),
      );
    }
  }, [kernel]);

  const exportFormatPayload = useCallback(
    (format: "csv" | "json" | "parquet") => {
      const record = {
        breadcrumbs: model.breadcrumbs,
        export_format: format,
        node_id: selection.nodeId,
        owner: postRef ? `${postRef.ownerKind ?? ""}:${postRef.ownerId ?? ""}` : null,
        properties: Object.fromEntries(
          model.properties.map((p) => [p.label, sanitizePlaceholderText(p.value)]),
        ),
        provenance: Object.fromEntries(
          model.provenance.map((p) => [p.label, sanitizePlaceholderText(p.value)]),
        ),
        resource_ref: postRef?.resourceRef ?? fdRef?.resourceRef ?? null,
        title: model.title,
      };
      if (format === "csv") {
        const lines = [
          "section,field,value",
          ...model.properties.map(
            (p) => `"property","${p.label}","${sanitizePlaceholderText(p.value)}"`,
          ),
          ...model.provenance.map(
            (p) => `"provenance","${p.label}","${sanitizePlaceholderText(p.value)}"`,
          ),
        ];
        copyTextArtifact(lines.join("\n"));
        return;
      }
      copyTextArtifact(JSON.stringify(record, null, 2));
    },
    [fdRef?.resourceRef, model, postRef, selection.nodeId],
  );

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `${idPrefix}:${selection.nodeId ?? scope}`,
      header: {
        breadcrumbs: model.breadcrumbs.map((b, i) => ({ id: `b-${i}`, label: b })),
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Open in Analysis",
                icon: ExternalLink,
                onRun: () => openInAnalysis(),
              },
            }
          : {}),
        extraMenuActions: [
          {
            id: "export-csv",
            label: "Export CSV Metadata",
            icon: Download,
            onSelect: () => exportFormatPayload("csv"),
          },
          {
            id: "export-json",
            label: "Export JSON Manifest",
            icon: Download,
            onSelect: () => exportFormatPayload("json"),
          },
          {
            id: "export-parquet",
            label: "Copy Parquet Descriptor",
            icon: FileOutput,
            onSelect: () => exportFormatPayload("parquet"),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon,
        title: () => model.title,
        kindLabel: `${model.physicalLabel} · ${model.methodLabel}`,
        entityId: postRef?.ownerId ?? selection.nodeId ?? undefined,
        statePill: () => ({
          tone: isPublished ? "ok" : "neutral",
          label: isPublished ? "Published" : sanitizePlaceholderText(model.status.execution),
        }),
      },
      facts: () => [
        { id: "scope", label: "Scope", value: scope },
        {
          id: "resource",
          label: "Resource",
          value: sanitizePlaceholderText(model.status.resource),
        },
        {
          id: "freshness",
          label: "Freshness",
          value: sanitizePlaceholderText(postRef?.freshness ?? "indexed"),
        },
      ],
      notices: () =>
        model.diagnostics.map((text, idx) => ({
          id: `diag-${idx}`,
          tone: "warn" as const,
          text,
        })),
      sections: [
        ...(hostFrequencyDomainExports &&
        kernel &&
        (fdRef !== null ||
          selection.kind === "results.frequency_domain.exports" ||
          Boolean(selection.nodeId?.includes("frequency-domain")))
          ? [
              {
                id: "fd-exports",
                title: "Frequency-Domain Export Bundle",
                icon: FileOutput,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <FrequencyDomainExportsInspectorPanel selection={selection} />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "properties",
          title: scope === "root" ? `${model.title} Catalog` : "Definition Properties",
          icon,
          defaultOpen: true,
          rows: [
            ...(scope === "root" && !postRef && emptyTitle && emptyDescription
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <EmptyState
                        description={emptyDescription}
                        heading={emptyTitle}
                        size="compact"
                      />
                    ),
                  },
                ]
              : []),
            ...(postRef
              ? [
                  {
                    type: "readonly" as const,
                    label: "Owner resource state",
                    format: () => model.status.resource,
                  },
                ]
              : []),
            ...model.properties.map((prop) => ({
              type: "readonly" as const,
              label: prop.label,
              mono: prop.mono,
              format: () => sanitizePlaceholderText(prop.value),
            })),
            {
              type: "readonly" as const,
              label: "Action policy",
              format: () => model.actionLabel,
            },
            {
              type: "custom" as const,
              wide: true,
              render: () => (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Postprocessing actions">
                  <Button
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={openInAnalysis}
                  >
                    <ExternalLink aria-hidden="true" size={13} />
                    <span>Open in Analysis</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => exportFormatPayload("csv")}
                  >
                    <Download aria-hidden="true" size={13} />
                    <span>Export CSV</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => exportFormatPayload("json")}
                  >
                    <Download aria-hidden="true" size={13} />
                    <span>Export JSON</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => exportFormatPayload("parquet")}
                  >
                    <FileOutput aria-hidden="true" size={13} />
                    <span>Export Parquet</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "provenance",
          title: "Provenance & Revisions",
          icon: GitCommit,
          defaultOpen: scope === "definition",
          rows: [
            ...model.provenance.map((prop) => ({
              type: "readonly" as const,
              label: prop.label,
              mono: prop.mono,
              format: () => sanitizePlaceholderText(prop.value),
            })),
            {
              type: "readonly" as const,
              label: "Selection source",
              format: () => selection.moduleSource,
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      emptyDescription,
      emptyTitle,
      exportFormatPayload,
      fdRef,
      hostFrequencyDomainExports,
      icon,
      idPrefix,
      isPublished,
      kernel,
      model,
      openInAnalysis,
      postRef,
      scope,
      selection,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function AnalysisViewsOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => analysisViewInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Pin a mode visualization or save an analysis plot configuration to reuse it across runs."
      emptyTitle="No analysis views saved yet"
      icon={Layers}
      idPrefix="results.analysis_views.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function AnalysisViewDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => analysisViewInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={Layers}
      idPrefix="results.analysis_views.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function DerivedValuesOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => derivedValueInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Derived scalars (coercivity, linewidth, Q-factor, topological charge) appear here once evaluated."
      emptyTitle="No derived scalar values defined yet"
      icon={Sigma}
      idPrefix="results.derived_values.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function DerivedValueDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => derivedValueInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={Sigma}
      idPrefix="results.derived_values.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function TablesOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => tableInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Enable Table Autosave before a Run stage or execute a sweep stage to record tabular observables."
      emptyTitle="No scalar tables published yet"
      icon={Table2}
      idPrefix="results.tables.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function TableDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => tableInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={Table2}
      idPrefix="results.tables.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function ExportsOverviewInspector({ selection }: InspectorPanelProps) {
  const model = useMemo(() => exportInspectorModel(selection, "root"), [selection]);
  return (
    <PostprocessingModelInspectorView
      emptyDescription="Export a field state, table CSV, or Zarr bundle to list downloadable artifacts here."
      emptyTitle="No exported archives yet"
      hostFrequencyDomainExports
      icon={FileOutput}
      idPrefix="results.exports.root"
      model={model}
      scope="root"
      selection={selection}
    />
  );
}

export function ExportDefinitionInspector({ selection }: InspectorPanelProps) {
  const scope = scopeForPostprocessingSelection(selection);
  const model = useMemo(() => exportInspectorModel(selection, scope), [scope, selection]);
  return (
    <PostprocessingModelInspectorView
      icon={FileOutput}
      idPrefix="results.exports.definition"
      model={model}
      scope={scope}
      selection={selection}
    />
  );
}

export function ObservationFramesTemplateOverviewPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  if (kernel?.api) {
    return <ConnectedObservationFramesOverviewPanel {...props} />;
  }
  if (kernel) {
    return <SyntheticObservationFramesOverviewPanel {...props} />;
  }
  return (
    <ObservationFramesOverviewView
      {...props}
      frames={[]}
      hasData
      pinnedId={null}
      resourceStatus="ready"
    />
  );
}

function ConnectedObservationFramesOverviewPanel(props: InspectorPanelProps) {
  const framesRes = useObservationFrameListResource();
  const pinned = useObservationSourceWorkspaceSelector((state) => state.pinned);
  return (
    <ObservationFramesOverviewView
      {...props}
      frames={framesRes.data?.frames ?? []}
      hasData={Boolean(framesRes.data)}
      pinnedId={pinned?.frameId ?? null}
      resourceStatus={framesRes.status}
    />
  );
}

function SyntheticObservationFramesOverviewPanel(props: InspectorPanelProps) {
  const framesRes = useObservationFrameListResource();
  const pinned = observationSourceWorkspaceStore.getSnapshot().pinned;
  return (
    <ObservationFramesOverviewView
      {...props}
      frames={framesRes.data?.frames ?? []}
      hasData={Boolean(framesRes.data)}
      pinnedId={pinned?.frameId ?? null}
      resourceStatus={framesRes.status}
    />
  );
}

function ObservationFramesOverviewView({
  frames,
  hasData = true,
  pinnedId,
  resourceStatus,
  selection,
}: InspectorPanelProps & {
  frames: NonNullable<ReturnType<typeof useObservationFrameListResource>["data"]>["frames"];
  hasData?: boolean;
  pinnedId: string | null;
  resourceStatus: string;
}) {
  const kernel = useContext(KernelContext);
  const frameCountLabel = hasData ? String(frames.length) : "—";
  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.observation_frames.root:${selection.nodeId ?? "frames"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "dyn", label: "Dynamics" },
          { id: "frames", label: "Observation Frames" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Clock,
        title: () => selection.label || "Observation Frames",
        kindLabel: "Durable accepted-state spatial snapshots",
        statePill: () => ({
          tone: resourceStatus === "ready" ? "ok" : "neutral",
          label:
            resourceStatus === "ready" && hasData
              ? `${frames.length} frames`
              : resourceStatus,
        }),
      },
      facts: () => [
        { id: "res-status", label: "Resource", value: resourceStatus },
        { id: "count", label: "Frames", value: frameCountLabel },
        { id: "pinned", label: "Pinned", value: pinnedId ?? "None" },
        { id: "axis", label: "Axis", value: "Simulation time t" },
      ],
      sections: [
        {
          id: "frames-info",
          title: "Durable State Snapshots",
          icon: Clock,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Resource status",
              format: () => resourceStatus,
            },
            {
              type: "readonly",
              label: "Frames",
              format: () => frameCountLabel,
            },
            {
              type: "readonly",
              label: "Pinned source",
              mono: true,
              format: () => pinnedId ?? "None",
            },
            ...(pinnedId
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() => observationSourceWorkspaceStore.clear()}
                      >
                        Unpin Active Source
                      </Button>
                    ),
                  },
                ]
              : []),
            ...(frames.length > 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Published frames",
                    wide: true,
                    render: () => (
                      <div className="grid gap-1.5 text-xs">
                        {frames.slice(0, 20).map((fr) => (
                          <div
                            className="flex items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-1.5"
                            key={fr.frame_id}
                          >
                            <span className="truncate font-mono">
                              {fr.frame_id} · step {fr.accepted_state_ref.id.accepted_step}
                            </span>
                            <Button
                              size="sm"
                              type="button"
                              variant="secondary"
                              onClick={() => {
                                kernel?.selection.set(
                                  {
                                    kind: "results.observation_frame",
                                    label: fr.frame_id,
                                    nodeId: `results:observation-frame:${fr.frame_id}`,
                                    objectId: null,
                                    ref: {
                                      acceptedRevision:
                                        fr.accepted_state_ref.generation.accepted_revision,
                                      acceptedStep:
                                        fr.accepted_state_ref.id.accepted_step,
                                      adapterId: fr.adapter_id,
                                      frameId: fr.frame_id,
                                      kind: "results.observation_frame",
                                      nodeId: `results:observation-frame:${fr.frame_id}`,
                                      runId: fr.run_id,
                                      runtimeEpoch:
                                        fr.accepted_state_ref.generation.runtime_epoch,
                                      stageId: fr.stage_id ?? "",
                                      stateDigest:
                                        fr.accepted_state_ref.id.state_digest,
                                      type: "observation-frame",
                                    },
                                  },
                                  "inspector",
                                );
                              }}
                            >
                              Inspect
                            </Button>
                          </div>
                        ))}
                      </div>
                    ),
                  },
                ]
              : [
                  {
                    type: "readonly" as const,
                    label: "Usage",
                    format: () =>
                      "Select a complete frame to inspect its immutable accepted-state identity and pin it as the historical source for analytical views.",
                  },
                ]),
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [frameCountLabel, frames, hasData, kernel, pinnedId, resourceStatus, selection.label, selection.nodeId],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ObservationFrameTemplateInspectorPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  if (kernel?.api) {
    return <ConnectedObservationFrameInspectorPanel {...props} />;
  }
  if (kernel) {
    const resourcesWithOptionalSnapshot = kernel.resources as unknown as
      | {
          getSnapshot?: (
            key: string,
          ) =>
            | { data?: Parameters<typeof sessionResourceIdentityFromStatus>[0] }
            | undefined;
        }
      | undefined;
    const snap = resourcesWithOptionalSnapshot?.getSnapshot?.(
      SESSION_STATUS_RESOURCE_KEY,
    );
    const statusData = snap?.data;
    const safeIdentity =
      statusData &&
      typeof statusData === "object" &&
      "session" in statusData &&
      Boolean(statusData.session)
        ? sessionResourceIdentityFromStatus(statusData)
        : null;
    return (
      <ObservationFrameWithSessionIdentity
        {...props}
        pinned={observationSourceWorkspaceStore.getSnapshot().pinned}
        sessionIdentity={safeIdentity}
      />
    );
  }
  return <ObservationFrameInspectorView {...props} />;
}

function ConnectedObservationFrameInspectorPanel(props: InspectorPanelProps) {
  const sessionIdentity = useSessionResourceIdentity();
  const pinned = useObservationSourceWorkspaceSelector((state) => state.pinned);
  return (
    <ObservationFrameWithSessionIdentity
      {...props}
      pinned={pinned}
      sessionIdentity={sessionIdentity}
    />
  );
}

function ObservationFrameWithSessionIdentity({
  pinned,
  selection,
  sessionIdentity,
}: InspectorPanelProps & {
  pinned: ReturnType<typeof observationSourceWorkspaceStore.getSnapshot>["pinned"];
  sessionIdentity: SessionResourceIdentity | null;
}) {
  const ref = selection.ref?.type === "observation-frame" ? selection.ref : null;
  const frame = useObservationFrameResource(ref?.frameId, {
    enabled: ref !== null,
  });
  const candidate =
    frame.data && sessionIdentity
      ? pinnedObservationSourceFromFrame(frame.data, sessionIdentity)
      : null;
  const isPinned =
    candidate !== null && pinnedObservationSourceEquals(pinned, candidate);

  return (
    <ObservationFrameInspectorView
      canPin={Boolean(candidate)}
      descriptor={frame.data ?? null}
      frameStatus={frame.status}
      isPinned={isPinned}
      selection={selection}
      onPin={() => {
        if (candidate) observationSourceWorkspaceStore.pin(candidate);
      }}
      onUnpin={() => observationSourceWorkspaceStore.clear()}
    />
  );
}

function ObservationFrameInspectorView({
  canPin = false,
  descriptor = null,
  frameStatus = "ready",
  isPinned = false,
  onPin,
  onUnpin,
  selection,
}: InspectorPanelProps & {
  canPin?: boolean;
  descriptor?: ReturnType<typeof useObservationFrameResource>["data"] | null;
  frameStatus?: string;
  isPinned?: boolean;
  onPin?: () => void;
  onUnpin?: () => void;
}) {
  const ref = selection.ref?.type === "observation-frame" ? selection.ref : null;

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.observation_frame:${selection.nodeId ?? ref?.frameId ?? "frame"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "frames", label: "Observation Frames" },
          { id: "frame", label: selection.label || ref?.frameId || "Frame" },
        ],
        ...(isPinned && onUnpin
          ? {
              primaryHeaderAction: {
                label: "Unpin source",
                icon: PinOff,
                onRun: () => onUnpin(),
              },
            }
          : canPin && onPin
            ? {
                primaryHeaderAction: {
                  label: "Pin source",
                  icon: Pin,
                  onRun: () => onPin(),
                },
              }
            : {}),
      },
      identity: {
        domain: "physics",
        icon: Clock,
        title: () => selection.label || ref?.frameId || descriptor?.frame_id || "Observation Frame",
        kindLabel: "Immutable accepted-state spatial snapshot",
        entityId: ref?.frameId ?? descriptor?.frame_id ?? selection.nodeId ?? undefined,
        statePill: () => ({
          tone: isPinned ? "live" : frameStatus === "ready" ? "ok" : "neutral",
          label: isPinned ? "Source pinned" : frameStatus,
        }),
      },
      facts: () => [
        {
          id: "node",
          label: "Frame",
          value: ref?.frameId ?? descriptor?.frame_id ?? "—",
        },
        {
          id: "step",
          label: "Step",
          value:
            ref?.acceptedStep != null
              ? String(ref.acceptedStep)
              : descriptor?.accepted_state_ref.id.accepted_step != null
                ? String(descriptor.accepted_state_ref.id.accepted_step)
                : "—",
        },
        {
          id: "stage",
          label: "Stage",
          value: ref?.stageId ?? descriptor?.stage_id ?? "—",
        },
        {
          id: "status",
          label: "Status",
          value: frameStatus,
        },
      ],
      sections: [
        {
          id: "observation-frame-identity",
          title: "Observation Frame Identity",
          icon: GitCommit,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Frame",
              mono: true,
              format: () => ref?.frameId ?? descriptor?.frame_id ?? "—",
            },
            {
              type: "readonly",
              label: "Run",
              mono: true,
              format: () => ref?.runId ?? descriptor?.run_id ?? "—",
            },
            {
              type: "readonly",
              label: "Stage",
              mono: true,
              format: () => ref?.stageId ?? descriptor?.stage_id ?? "—",
            },
            {
              type: "readonly",
              label: "Accepted step",
              mono: true,
              format: () =>
                ref?.acceptedStep != null
                  ? String(ref.acceptedStep)
                  : descriptor?.accepted_state_ref.id.accepted_step != null
                    ? String(descriptor.accepted_state_ref.id.accepted_step)
                    : "—",
            },
            {
              type: "readonly",
              label: "Accepted revision",
              mono: true,
              format: () =>
                ref?.acceptedRevision != null
                  ? String(ref.acceptedRevision)
                  : descriptor?.accepted_state_ref.generation.accepted_revision != null
                    ? String(descriptor.accepted_state_ref.generation.accepted_revision)
                    : "—",
            },
            {
              type: "readonly",
              label: "Runtime epoch",
              mono: true,
              format: () =>
                ref?.runtimeEpoch != null
                  ? String(ref.runtimeEpoch)
                  : descriptor?.accepted_state_ref.generation.runtime_epoch != null
                    ? String(descriptor.accepted_state_ref.generation.runtime_epoch)
                    : "—",
            },
            {
              type: "readonly",
              label: "Adapter",
              mono: true,
              format: () => ref?.adapterId ?? descriptor?.adapter_id ?? "—",
            },
            {
              type: "readonly",
              label: "State digest",
              mono: true,
              format: () =>
                ref?.stateDigest ?? descriptor?.accepted_state_ref.id.state_digest ?? "—",
            },
          ],
        },
        {
          id: "published-data",
          title: "Published Data & Source Actions",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Status",
              format: () => frameStatus,
            },
            {
              type: "readonly",
              label: "Grid cells",
              format: () => (descriptor ? descriptor.grid_cells.join(" × ") : "—"),
            },
            {
              type: "readonly",
              label: "Quantities",
              format: () => descriptor?.quantity_ids.join(", ") || "—",
            },
            {
              type: "readonly",
              label: "State codec",
              mono: true,
              format: () =>
                descriptor
                  ? `${descriptor.state_codec_id} ${descriptor.state_codec_version}`
                  : "—",
            },
            {
              type: "custom",
              label: "Observation source",
              wide: true,
              render: () => (
                <div
                  aria-label="Observation source actions"
                  className="flex flex-wrap gap-2"
                  role="group"
                >
                  <Button
                    disabled={!canPin || isPinned}
                    disabledReason={
                      isPinned
                        ? "This observation frame is already pinned as the active source"
                        : "Frame descriptor must be ready before pinning"
                    }
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => onPin?.()}
                  >
                    <Pin aria-hidden="true" size={13} />
                    <span>{isPinned ? "Source pinned" : "Pin source"}</span>
                  </Button>
                  {isPinned && onUnpin ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={onUnpin}
                    >
                      <PinOff aria-hidden="true" size={13} />
                      <span>Unpin</span>
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      canPin,
      descriptor,
      frameStatus,
      isPinned,
      onPin,
      onUnpin,
      ref,
      selection.label,
      selection.nodeId,
    ],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

const PINNED_VISUALIZATIONS_KIND = "results.pinned_visualizations.root";

function selectedPinnedGroup(selection: InspectorPanelProps["selection"]) {
  const ref = selection.ref;
  if (
    selection.kind !== PINNED_VISUALIZATIONS_KIND ||
    ref?.type !== "analysis-pinned-group" ||
    ref.kind !== PINNED_VISUALIZATIONS_KIND ||
    selection.nodeId === null ||
    selection.nodeId !== ref.nodeId ||
    ref.moduleId.trim().length === 0 ||
    ref.runId.trim().length === 0
  ) {
    return null;
  }
  return ref;
}

function modeVisualizationSchema(moduleId: string): string | undefined {
  const nodeKind = `${moduleId}.mode_visualization` as AnalysisNodeKind;
  return ANALYSIS_FEATURE_MANIFESTS.find((manifest) => manifest.id === moduleId)
    ?.definitionSchemas[nodeKind];
}

function isDrivenPinnedVisualization(def: PostprocessingDefinition): boolean {
  const fieldId = def.data_ref.field_id ?? "";
  if (fieldId.startsWith("analysis:eigen:")) return false;
  if (fieldId.startsWith("analysis:frequency-response:")) return true;
  const settings =
    def.settings && typeof def.settings === "object" && !Array.isArray(def.settings)
      ? (def.settings as Record<string, unknown>)
      : null;
  if (
    settings?.source === "frequency-response" ||
    settings?.study_product === "driven_response" ||
    typeof settings?.frequencyIndex === "number" ||
    typeof settings?.frequency_index === "number"
  ) {
    return true;
  }
  const itemId = (def.data_ref.item_id ?? "").toLowerCase();
  if (itemId.startsWith("frequency") || itemId.startsWith("response")) {
    return true;
  }
  const datasetId = def.data_ref.dataset_id.toLowerCase();
  return (
    datasetId.includes("driven") ||
    datasetId.includes("frequency_response") ||
    datasetId.includes("frequency-response")
  );
}

function resolvePinnedFrequencyIndex(def: PostprocessingDefinition): number | undefined {
  const settings =
    def.settings && typeof def.settings === "object" && !Array.isArray(def.settings)
      ? (def.settings as Record<string, unknown>)
      : null;
  if (
    typeof settings?.frequencyIndex === "number" &&
    Number.isFinite(settings.frequencyIndex)
  ) {
    return settings.frequencyIndex;
  }
  if (
    typeof settings?.frequency_index === "number" &&
    Number.isFinite(settings.frequency_index)
  ) {
    return settings.frequency_index;
  }
  const itemMatch = def.data_ref.item_id?.match(/(\d+)$/);
  if (itemMatch?.[1] !== undefined) {
    const parsed = Number(itemMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fieldMatch = def.data_ref.field_id?.match(/(?:frequency|field|point)[-_](\d+)$/i);
  if (fieldMatch?.[1] !== undefined) {
    const parsed = Number(fieldMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function PinnedVisualizationsTemplateInspectorPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedPinnedVisualizationsTemplate {...props} />
  ) : (
    <PinnedVisualizationsTemplateView
      {...props}
      definitions={[]}
      resourceStatus="ready"
      sceneRevision={null}
    />
  );
}

function ConnectedPinnedVisualizationsTemplate(props: InspectorPanelProps) {
  const definitionsRes = usePostprocessingDefinitionsResource();
  return (
    <PinnedVisualizationsTemplateView
      {...props}
      definitions={definitionsRes.data?.definitions ?? []}
      resourceStatus={definitionsRes.status}
      sceneRevision={definitionsRes.data?.scene_revision ?? null}
    />
  );
}

function PinnedVisualizationsTemplateView({
  definitions,
  resourceStatus,
  sceneRevision,
  selection,
}: InspectorPanelProps & {
  definitions: readonly PostprocessingDefinition[];
  resourceStatus: string;
  sceneRevision: number | null;
}) {
  const kernel = useContext(KernelContext);
  const group = selectedPinnedGroup(selection);
  const nodeKind = group ? `${group.moduleId}.mode_visualization` : null;
  const schema = group ? modeVisualizationSchema(group.moduleId) : undefined;
  const unpublishedGroup = group === null || schema === undefined;

  const pinned = useMemo(() => {
    if (!group || !nodeKind || !schema) return [];
    return definitions.filter(
      (definition) =>
        definition.module_id === group.moduleId &&
        definition.data_ref.run_id === group.runId &&
        definition.node_kind === nodeKind &&
        definition.definition_schema === schema,
    );
  }, [definitions, group, nodeKind, schema]);

  const leafDefinitionId = useMemo(() => {
    if (!unpublishedGroup || !selection.nodeId) return null;
    const parts = selection.nodeId.split(":pinned:");
    return parts.length > 1 && parts[1] ? decodeURIComponent(parts[1]) : null;
  }, [selection.nodeId, unpublishedGroup]);

  const activatePinnedIn3D = useCallback(
    (def: PostprocessingDefinition) => {
      if (!kernel || !def.data_ref.field_id) return;
      const isDriven = isDrivenPinnedVisualization(def);
      const frequencyIndex = isDriven ? resolvePinnedFrequencyIndex(def) : undefined;
      void kernel.commands.execute(
        isDriven
          ? "analysis.frequency-response.plot-response-field-3d"
          : "analysis.eigen.plot-mode-3d",
        createCommandContext("inspector", kernel, {
          sourceDetail: "results.pinned_visualizations.root",
        }),
        {
          fieldId: def.data_ref.field_id,
          ...(frequencyIndex !== undefined ? { frequencyIndex } : {}),
          label: def.label,
          phaseRad: 0,
          source: isDriven ? "frequency-response" : "eigen-mode",
          view: "phase_rotated_real",
        },
      );
    },
    [kernel],
  );

  const openPinnedPublishedTarget = useCallback(
    (def: PostprocessingDefinition) => {
      if (!kernel) return;
      const dRef = def.data_ref;
      const isDispersion = def.module_id.includes("dispersion");
      const isDriven = isDrivenPinnedVisualization(def);
      const targetKind = isDriven
        ? isDispersion
          ? "results.dispersion.driven.field_at_k"
          : "results.resonance.driven.field"
        : isDispersion
          ? "results.dispersion.modal.mode_at_k"
          : "results.resonance.modal.mode";
      const targetNodeId = `${selection.nodeId ?? "results:pinned"}:${def.definition_id}`;
      const sampleMatch = dRef.sample_id?.match(/(\d+)$/);
      const itemMatch = dRef.item_id?.match(/(\d+)$/);
      const parsedSampleIndex = sampleMatch ? Number(sampleMatch[1]) : undefined;
      const parsedItemIndex = itemMatch ? Number(itemMatch[1]) : undefined;
      const frequencyIndex = isDriven ? resolvePinnedFrequencyIndex(def) : undefined;
      kernel.selection.set(
        {
          kind: targetKind,
          label: def.label,
          nodeId: targetNodeId,
          objectId: null,
          ref: {
            analysisRunId: dRef.run_id,
            datasetId: dRef.dataset_id,
            datasetRevision: dRef.dataset_revision,
            fieldId: dRef.field_id ?? undefined,
            ...(isDriven && frequencyIndex !== undefined
              ? { frequencyIndex }
              : {}),
            kind: targetKind,
            modeId: dRef.item_id ?? undefined,
            ...(!isDriven && parsedItemIndex !== undefined
              ? { modeIndex: parsedItemIndex }
              : {}),
            nodeId: targetNodeId,
            sampleId: dRef.sample_id ?? undefined,
            ...(parsedSampleIndex !== undefined ? { sampleIndex: parsedSampleIndex } : {}),
            source: isDriven ? "frequency-response" : "eigen-mode",
            type: "frequency-domain",
          },
        },
        "inspector",
      );
    },
    [kernel, selection.nodeId],
  );

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.pinned_visualizations.root:${selection.nodeId ?? "pinned"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "pinned", label: "Pinned Visualizations" },
        ],
      },
      identity: {
        domain: "visualization",
        icon: Pin,
        title: () =>
          unpublishedGroup
            ? selection.label || "Pinned visualization"
            : "Pinned Visualizations",
        kindLabel: "Project-persisted 3D mode & field views",
        statePill: () => ({
          tone: unpublishedGroup ? "warn" : pinned.length > 0 ? "ok" : "neutral",
          label: unpublishedGroup ? "not published" : `${pinned.length} pinned`,
        }),
      },
      facts: () => [
        { id: "count", label: "Pinned", value: String(pinned.length) },
        { id: "storage", label: "Storage", value: "project" },
        {
          id: "rev",
          label: "Scene revision",
          value: sceneRevision !== null ? String(sceneRevision) : "—",
        },
        {
          id: "state",
          label: "State",
          value: unpublishedGroup ? "not published" : resourceStatus,
        },
      ],
      notices: () =>
        unpublishedGroup
          ? [
              {
                id: "unpublished-pin",
                tone: "warn",
                text: "The pinned field is not published by this run; remove it or rerun the study.",
                ...(leafDefinitionId && kernel
                  ? {
                      quickFix: {
                        label: "Unpin visualization",
                        onApply: () => {
                          void kernel.commands.execute(
                            UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
                            createCommandContext("inspector", kernel),
                            { definitionId: leafDefinitionId },
                          );
                        },
                      },
                    }
                  : {}),
              },
            ]
          : [],
      sections: [
        {
          id: "pinned-list",
          title: "Saved Visualization Pins",
          icon: Pin,
          defaultOpen: true,
          rows: unpublishedGroup
            ? [
                {
                  type: "readonly",
                  label: "Field",
                  format: () =>
                    "The pinned field is not published by this run; remove it or rerun the study.",
                },
              ]
            : pinned.length === 0
              ? [
                  {
                    type: "custom",
                    label: "Pinned items",
                    wide: true,
                    render: () => (
                      <EmptyState
                        description="Use Pin Mode Visualization on any eigenmode or response field node to bookmark it here."
                        heading="No pinned visualizations"
                      />
                    ),
                  },
                ]
              : pinned.map((def) => ({
                  type: "custom" as const,
                  label: def.label,
                  wide: true,
                  render: () => (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-1.5 text-xs">
                      <div className="min-w-0">
                        <span className="block truncate font-medium">{def.label}</span>
                        <span className="block truncate text-fm-muted font-mono">
                          {def.module_id} · {def.data_ref.field_id ?? def.definition_id}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          aria-label={`Activate ${def.label} in 3D`}
                          disabled={!def.data_ref.field_id}
                          disabledReason="Pinned definition has no published field ID"
                          size="sm"
                          type="button"
                          variant="primary"
                          onClick={() => activatePinnedIn3D(def)}
                        >
                          <Box aria-hidden="true" size={12} />
                          <span>Activate in 3D</span>
                        </Button>
                        <Button
                          aria-label={`Open ${def.label}`}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => openPinnedPublishedTarget(def)}
                        >
                          <span>Open</span>
                        </Button>
                        <Button
                          aria-label={`Unpin ${def.label}`}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            if (!kernel) return;
                            void kernel.commands.execute(
                              UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
                              createCommandContext("inspector", kernel),
                              { definitionId: def.definition_id },
                            );
                          }}
                        >
                          <PinOff aria-hidden="true" size={13} />
                        </Button>
                      </div>
                    </div>
                  ),
                })),
        },
        {
          id: "storage-contract",
          title: "Storage & Identity",
          icon: Database,
          defaultOpen: false,
          rows: [
            {
              type: "readonly",
              label: "Resource",
              mono: true,
              format: () => "analysis/postprocessing/definitions",
            },
            {
              type: "readonly",
              label: "Identity",
              format: () => "run · stage · revision · field",
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activatePinnedIn3D,
      kernel,
      leafDefinitionId,
      openPinnedPublishedTarget,
      pinned,
      resourceStatus,
      sceneRevision,
      selection.label,
      selection.nodeId,
      unpublishedGroup,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function MaterializedDatasetTemplateInspectorPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedMaterializedDatasetTemplatePanel {...props} />;
  }
  return (
    <MaterializedDatasetTemplateView
      {...props}
      activeProjectId={null}
      dataset={null}
      errorMessage={null}
      matRef={materializedDatasetSelection(props.selection)}
      projectMatches
      refreshWarning={null}
      resourceStatus="idle"
      savedPresentation={null}
    />
  );
}

function ConnectedMaterializedDatasetTemplatePanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const matRef = materializedDatasetSelection(props.selection);
  const project = useProjectDocumentSnapshot();
  const { presentation } = useSavedFieldPresentation();
  const activeProjectId =
    project.state === "ready" ? project.resource.project_id : null;
  const projectMatches =
    matRef !== null &&
    materializedDatasetSelectionMatchesProject(matRef, activeProjectId);
  const resource = useMaterializedDatasetResource(
    matRef?.projectId,
    matRef?.runId,
    matRef?.solutionSetId,
    matRef?.containingRevision,
    matRef?.memberId,
    matRef?.artifactId,
    { enabled: projectMatches },
  );
  const savedPresentation = useMemo(
    () => (matRef ? savedFieldPresentationForDataset(presentation, matRef) : null),
    [matRef, presentation],
  );
  return (
    <MaterializedDatasetTemplateView
      {...props}
      activeProjectId={activeProjectId}
      dataset={resource.data ?? null}
      errorMessage={resource.error?.message ?? null}
      matRef={matRef}
      projectMatches={projectMatches}
      refreshWarning={resource.refreshError?.message ?? null}
      resourceStatus={resource.status}
      savedPresentation={savedPresentation}
      onResetSavedDisplay={() => {
        if (kernel) {
          returnToCurrentFieldView(
            kernel.visualization,
            kernel.selection,
            "inspector",
          );
        }
      }}
    />
  );
}

function formatDatasetFunctionSpace(
  functionSpace: MaterializedDatasetResource["field"]["descriptor"]["function_space"],
): string {
  if (!functionSpace) return "—";
  return `${functionSpace.family} ${functionSpace.order} · ${functionSpace.space_id} · ${functionSpace.ordering}`;
}

function MaterializedDatasetTemplateView({
  activeProjectId,
  dataset,
  errorMessage,
  matRef,
  onResetSavedDisplay,
  projectMatches,
  refreshWarning,
  resourceStatus,
  savedPresentation,
  selection,
}: InspectorPanelProps & {
  activeProjectId: string | null;
  dataset: MaterializedDatasetResource | null;
  errorMessage: string | null;
  matRef: ReturnType<typeof materializedDatasetSelection>;
  onResetSavedDisplay?: () => void;
  projectMatches: boolean;
  refreshWarning: string | null;
  resourceStatus: string;
  savedPresentation: ReturnType<typeof savedFieldPresentationForDataset>;
}) {
  const kernel = useContext(KernelContext);
  const identityMismatch =
    matRef !== null &&
    dataset !== null &&
    !materializedDatasetSelectionMatches(matRef, dataset);
  const validDataset = identityMismatch ? null : dataset;

  const alertMessage = useMemo(() => {
    if (!matRef) {
      return kernel ? "Pinned dataset selection is missing." : null;
    }
    if (!projectMatches) {
      return `The pinned dataset belongs to project ${matRef.projectId}, but the active project is ${activeProjectId ?? "not open"}. Open the owning project to inspect it.`;
    }
    if (errorMessage) {
      return `Could not load the pinned materialized dataset: ${errorMessage}`;
    }
    if (identityMismatch) {
      return "The returned manifest does not match the selected immutable identity.";
    }
    return null;
  }, [activeProjectId, errorMessage, identityMismatch, kernel, matRef, projectMatches]);

  const statusNotice = useMemo(() => {
    if (alertMessage || !matRef || !kernel) return null;
    if (resourceStatus === "loading" && !dataset) {
      return "Verifying pinned materialized dataset…";
    }
    if (!dataset) {
      return "Materialized dataset is not published yet.";
    }
    return null;
  }, [alertMessage, dataset, kernel, matRef, resourceStatus]);

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.materialized_dataset:${selection.nodeId ?? matRef?.artifactId ?? "mat"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "mat", label: selection.label || "Materialized Dataset" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Database,
        title: () =>
          validDataset?.dataset.dataset_id ||
          selection.label ||
          "Materialized Field Dataset",
        kindLabel: "Pinned Zarr v3 solution array",
        entityId: validDataset?.dataset.dataset_id ?? matRef?.datasetId ?? undefined,
        statePill: () => ({
          tone: alertMessage ? "err" : validDataset ? "ok" : "neutral",
          label: alertMessage
            ? "Mismatch"
            : validDataset
              ? `Integrity ${validDataset.integrity}`
              : resourceStatus === "loading"
                ? "Verifying…"
                : "Materialized",
        }),
      },
      facts: () => [
        {
          id: "field",
          label: "Field",
          value: validDataset?.field_id ?? matRef?.fieldId ?? "—",
        },
        {
          id: "unit",
          label: "Unit",
          value: validDataset?.field.descriptor.unit ?? "—",
        },
        {
          id: "dtype",
          label: "Dtype",
          value: validDataset?.field.coverage.dtype ?? "—",
        },
        {
          id: "chunks",
          label: "Chunks",
          value:
            validDataset?.field.coverage.chunk_count != null
              ? String(validDataset.field.coverage.chunk_count)
              : "—",
        },
      ],
      notices: () => [
        ...(alertMessage
          ? [{ id: "mat-alert", tone: "err" as const, text: alertMessage }]
          : []),
        ...(statusNotice
          ? [{ id: "mat-status", tone: "info" as const, text: statusNotice }]
          : []),
      ],
      sections: [
        ...(validDataset && savedPresentation
          ? [
              {
                id: "saved-field-3d",
                title: "Saved Field 3D Visualization",
                icon: Layers,
                defaultOpen: true,
                live: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <SavedFieldVisualizationPanel
                        dataset={validDataset}
                        presentation={savedPresentation}
                        refreshWarning={refreshWarning}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "pinned-identity",
          title: "Pinned Identity",
          icon: GitCommit,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Project",
              mono: true,
              format: () => validDataset?.project_id ?? matRef?.projectId ?? "—",
            },
            {
              type: "readonly",
              label: "Run",
              mono: true,
              format: () => validDataset?.run_id ?? matRef?.runId ?? "—",
            },
            {
              type: "readonly",
              label: "SolutionSet",
              mono: true,
              format: () =>
                validDataset?.solution_set_id ?? matRef?.solutionSetId ?? "—",
            },
            {
              type: "readonly",
              label: "Containing revision",
              mono: true,
              format: () =>
                validDataset?.containing_solution_revision ??
                matRef?.containingRevision ??
                "—",
            },
            {
              type: "readonly",
              label: "Owner revision",
              mono: true,
              format: () => validDataset?.owner_solution_revision ?? "—",
            },
            {
              type: "readonly",
              label: "Member",
              mono: true,
              format: () => validDataset?.member_id ?? matRef?.memberId ?? "—",
            },
            {
              type: "readonly",
              label: "Manifest root",
              mono: true,
              format: () =>
                validDataset?.manifest_object_ref ?? matRef?.manifestObjectRef ?? "—",
            },
          ],
        },
        ...(validDataset
          ? [
              {
                id: "dataset-status",
                title: "Dataset Status & Assessment",
                icon: Activity,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="success">Integrity {validDataset.integrity}</Badge>
                        <Badge variant="secondary">
                          Availability {validDataset.dataset.status.availability}
                        </Badge>
                        <Badge variant="secondary">
                          Execution {validDataset.owner_execution_status}
                        </Badge>
                        <Badge variant="secondary">
                          Assessment {validDataset.owner_scientific_assessment.status}
                        </Badge>
                      </div>
                    ),
                  },
                  {
                    type: "readonly" as const,
                    label: "Dataset",
                    mono: true,
                    format: () =>
                      `${validDataset.dataset.dataset_id} · revision ${validDataset.dataset.revision}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Definition",
                    mono: true,
                    format: () =>
                      `${validDataset.definition.definition_id} · revision ${validDataset.definition.revision}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Scientific reason",
                    format: () =>
                      validDataset.owner_scientific_assessment.reason ?? "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Evidence artifacts",
                    format: () =>
                      String(validDataset.owner_scientific_assessment.evidence_artifact_count),
                  },
                ],
              },
              {
                id: "field-semantics",
                title: "Field Semantics",
                icon: Sigma,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Sample / item / field",
                    mono: true,
                    format: () =>
                      `${validDataset.sample_id} / ${validDataset.item_id} / ${validDataset.field_id}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Quantity",
                    mono: true,
                    format: () => validDataset.field.descriptor.quantity_id,
                  },
                  {
                    type: "readonly" as const,
                    label: "Unit",
                    format: () => validDataset.field.descriptor.unit,
                  },
                  {
                    type: "readonly" as const,
                    label: "Frame",
                    mono: true,
                    format: () =>
                      `${validDataset.field.descriptor.frame.kind} · ${validDataset.field.descriptor.frame.frame_id}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Support",
                    mono: true,
                    format: () =>
                      validDataset.field.descriptor.active_support.support_fingerprint,
                  },
                  {
                    type: "readonly" as const,
                    label: "Function space",
                    format: () =>
                      formatDatasetFunctionSpace(validDataset.field.descriptor.function_space),
                  },
                  {
                    type: "readonly" as const,
                    label: "Plane / representation",
                    format: () =>
                      `${validDataset.field.plane} / ${validDataset.field.descriptor.value_representation}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Normalization",
                    format: () => validDataset.field.descriptor.normalization,
                  },
                  {
                    type: "readonly" as const,
                    label: "Complex encoding",
                    format: () => validDataset.field.descriptor.complex_encoding,
                  },
                ],
              },
              {
                id: "coverage-provenance",
                title: "Zarr Coverage, Chunks & Provenance",
                icon: Database,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Dtype / endian",
                    mono: true,
                    format: () =>
                      `${validDataset.field.coverage.dtype} / ${validDataset.field.coverage.endian}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Elements / components",
                    mono: true,
                    format: () =>
                      `${validDataset.field.coverage.total_elements} / ${validDataset.field.coverage.component_count}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Bytes / chunks",
                    mono: true,
                    format: () =>
                      `${validDataset.field.coverage.total_bytes} / ${validDataset.field.coverage.chunk_count}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Tensor artifact",
                    mono: true,
                    format: () => validDataset.field.tensor_artifact.artifact_id,
                  },
                  {
                    type: "readonly" as const,
                    label: "Tensor object",
                    mono: true,
                    format: () => validDataset.field.tensor_artifact.object_ref,
                  },
                  {
                    type: "readonly" as const,
                    label: "RunSpec digest",
                    mono: true,
                    format: () => validDataset.source.run_spec_digest,
                  },
                  {
                    type: "readonly" as const,
                    label: "Source member / artifact",
                    mono: true,
                    format: () =>
                      `${validDataset.source.member_id} / ${validDataset.source.artifact_id}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Source tensor",
                    mono: true,
                    format: () => validDataset.source.tensor_object_ref,
                  },
                  {
                    type: "custom" as const,
                    label: "Windowed values",
                    wide: true,
                    render: () => (
                      <MaterializedDatasetValues
                        dataset={validDataset}
                        key={JSON.stringify(matRef)}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      commitBar: savedPresentation
        ? {
            mode: "liveViewport",
            hasOverrides: () => false,
            onResetDisplay: () => {
              onResetSavedDisplay?.();
            },
          }
        : { mode: "readOnly" },
    }),
    [
      alertMessage,
      matRef,
      onResetSavedDisplay,
      refreshWarning,
      resourceStatus,
      savedPresentation,
      selection.label,
      selection.nodeId,
      statusNotice,
      validDataset,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

function formatFiniteStat(
  value: number | null | undefined,
  unit?: string | null,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const suffix = unit ? ` ${unit}` : "";
  return `${value.toPrecision(6)}${suffix}`;
}

export function FieldQuantityTemplateInspectorPanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const requestedId = props.selection.nodeId?.startsWith("results:field:")
    ? props.selection.nodeId.slice("results:field:".length)
    : "m";
  return kernel ? (
    <ConnectedFieldQuantityTemplate {...props} requestedId={requestedId} />
  ) : (
    <FieldQuantityTemplateView
      {...props}
      meta={null}
      requestedId={requestedId}
      resourceStatus="idle"
    />
  );
}

function ConnectedFieldQuantityTemplate(
  props: InspectorPanelProps & { requestedId: string },
) {
  const fieldRes = useFieldMetaResource({ quantityId: props.requestedId });
  return (
    <FieldQuantityTemplateView
      {...props}
      meta={fieldRes.data ?? null}
      resourceStatus={fieldRes.status}
    />
  );
}

function FieldQuantityTemplateView({
  meta,
  requestedId,
  resourceStatus,
  selection,
}: InspectorPanelProps & {
  meta: ReturnType<typeof useFieldMetaResource>["data"];
  requestedId: string;
  resourceStatus: string;
}) {
  const kernel = useContext(KernelContext);
  const state = meta?.state ?? (resourceStatus === "idle" ? "Published" : resourceStatus);
  const statsRecord = (meta?.stats ?? null) as Record<string, unknown> | null;
  const normValue =
    typeof statsRecord?.norm === "number"
      ? statsRecord.norm
      : typeof statsRecord?.l2_norm === "number"
        ? statsRecord.l2_norm
        : null;

  const showIn3D = useCallback(() => {
    kernel?.layout?.setActiveViewportMainModule?.("viewport-3d");
    kernel?.layout?.setFocusedSlot?.("viewport-main");
    if (kernel) {
      void kernel.commands.execute(
        "workspace.focus-selection",
        createCommandContext("inspector", kernel),
      );
    }
  }, [kernel]);

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.field_quantity:${requestedId}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "field", label: meta?.label ?? selection.label ?? requestedId },
        ],
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Show in 3D",
                icon: Box,
                onRun: () => showIn3D(),
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: () => meta?.label ?? selection.label ?? requestedId,
        kindLabel: "Materialized spatial field quantity",
        entityId: meta?.quantity_id ?? requestedId,
        statePill: () => ({
          tone: state === "complete" || state === "ready" ? "ok" : "neutral",
          label: state,
        }),
      },
      facts: () => [
        {
          id: "comp",
          label: "Components",
          value: meta ? String(meta.components) : "—",
        },
        { id: "loc", label: "Location", value: meta?.location ?? "—" },
        { id: "state", label: "State", value: state },
        {
          id: "stale",
          label: "Stale steps",
          value: meta ? String(meta.stale_by_steps) : "—",
        },
      ],
      sections: [
        {
          id: "identity-support",
          title: "Field Quantity & Support",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Quantity",
              format: () => meta?.label ?? selection.label ?? requestedId,
            },
            {
              type: "readonly",
              label: "Quantity ID",
              mono: true,
              format: () => meta?.quantity_id ?? requestedId,
            },
            {
              type: "readonly",
              label: "Unit",
              format: () => meta?.unit ?? "—",
            },
            {
              type: "readonly",
              label: "Field kind",
              format: () => meta?.kind ?? "—",
            },
            {
              type: "readonly",
              label: "Support location",
              format: () => meta?.location ?? "—",
            },
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={showIn3D}
                  >
                    <Box aria-hidden="true" size={13} />
                    <span>Show in 3D</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "stats",
          title: "Spatial Statistics",
          icon: Gauge,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Minimum",
              mono: true,
              format: () => formatFiniteStat(meta?.stats?.min, meta?.unit),
            },
            {
              type: "readonly",
              label: "Mean",
              mono: true,
              format: () => formatFiniteStat(meta?.stats?.mean, meta?.unit),
            },
            {
              type: "readonly",
              label: "Maximum",
              mono: true,
              format: () => formatFiniteStat(meta?.stats?.max, meta?.unit),
            },
            {
              type: "readonly",
              label: "Norm",
              mono: true,
              format: () => formatFiniteStat(normValue, meta?.unit),
            },
          ],
        },
        {
          id: "materialization",
          title: "Materialization",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Resource state",
              format: () => resourceStatus,
            },
            {
              type: "readonly",
              label: "Materialization state",
              format: () => state,
            },
            {
              type: "readonly",
              label: "Error",
              format: () => meta?.materialization_error ?? "none",
            },
            {
              type: "readonly",
              label: "Wall time",
              mono: true,
              format: () => formatFiniteStat(meta?.materialization_wall_time_ns, "ns"),
            },
          ],
        },
        {
          id: "provenance",
          title: "Provenance",
          icon: History,
          defaultOpen: false,
          rows: [
            {
              type: "readonly",
              label: "Field revision",
              mono: true,
              format: () => (meta ? String(meta.field_revision) : "—"),
            },
            {
              type: "readonly",
              label: "Source revision",
              mono: true,
              format: () => (meta ? String(meta.source_revision) : "—"),
            },
            {
              type: "readonly",
              label: "Source step",
              mono: true,
              format: () => (meta ? String(meta.source_step) : "—"),
            },
            {
              type: "readonly",
              label: "Domain generation",
              mono: true,
              format: () => meta?.domain_generation_id ?? "—",
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [kernel, meta, normValue, requestedId, resourceStatus, selection.label, showIn3D, state],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
