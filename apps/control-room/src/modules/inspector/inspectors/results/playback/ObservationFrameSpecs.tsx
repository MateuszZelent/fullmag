"use client";

import {
  Clock,
  Database,
  GitCommit,
  Pin,
  PinOff,
} from "lucide-react";
import { useContext, useMemo } from "react";
import { KernelContext } from "@/kernel/KernelContext";
import {
  useObservationFrameListResource,
  useObservationFrameResource,
} from "@/kernel/resources/observationFrameResources";
import {
  sessionResourceIdentityFromStatus,
  type SessionResourceIdentity,
} from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  observationSourceWorkspaceStore,
  pinnedObservationSourceEquals,
  pinnedObservationSourceFromFrame,
} from "@/kernel/workspace/observationSourceWorkspace";
import { useObservationSourceWorkspaceSelector } from "@/kernel/workspace/useObservationSourceWorkspace";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import { type EmptyPostprocessingDraft, DEFAULT_POSTPROCESSING_DRAFT } from "./playbackShared";

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
