import type { FieldMetaResource, ObservationFrameResource, PreparedInitialStateResource } from "../api/apiTypes";
import type { ResourceResult } from "../resources/resourceTypes";
import type { SessionResourceIdentity } from "../resources/sessionResourceIdentity";
import { sessionResourceIdentityKey } from "../resources/sessionResourceIdentity";

export interface PinnedObservationSource {
  acceptedRevision: number;
  acceptedStep: number;
  adapterId: string;
  frameId: string;
  runId: string;
  runtimeEpoch: number;
  sessionIdentityKey: string;
  stageId: string;
  stateDigest: string;
}

export interface PreparedMagnetizationPreview {
  source: PreparedInitialStateResource;
  objectId: string;
  regionId: string | null;
  sessionIdentityKey: string;
}

export type PreparedMagnetizationAvailability =
  | "checking" | "current" | "earlier-domain" | "superseded" | "unavailable";

export function resolvePreparedMagnetizationAvailability(
  source: PreparedInitialStateResource,
  live: { domainGenerationId: string | null; sceneRevision: number | null },
  meta: Pick<ResourceResult<FieldMetaResource | null>, "data" | "status">,
): PreparedMagnetizationAvailability {
  if (live.sceneRevision === null || live.sceneRevision < source.scene_revision) return "checking";
  if (live.domainGenerationId && live.domainGenerationId !== source.domain_generation_id) return "earlier-domain";
  if (live.sceneRevision > source.scene_revision) return "superseded";
  if (meta.status === "error") return "unavailable";
  if (!live.domainGenerationId || meta.status !== "ready") return "checking";

  const bundle = meta.data?.publication_bundle;
  return meta.data?.observation_frame?.observation_frame_id === source.observation_frame_id &&
    meta.data.domain_generation_id === source.domain_generation_id &&
    (!bundle || bundle.publication_id === source.publication_id)
    ? "current"
    : "superseded";
}

export interface ObservationSourceWorkspaceState {
  pinned: PinnedObservationSource | null;
  prepared: PreparedMagnetizationPreview | null;
}

type ObservationSourceWorkspaceListener = () => void;

export const EMPTY_OBSERVATION_SOURCE: ObservationSourceWorkspaceState = { pinned: null, prepared: null };

class ObservationSourceWorkspaceStore {
  private readonly listeners = new Set<ObservationSourceWorkspaceListener>();
  private state = EMPTY_OBSERVATION_SOURCE;

  getSnapshot = (): ObservationSourceWorkspaceState => this.state;

  subscribe = (listener: ObservationSourceWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  pin(source: PinnedObservationSource): void {
    const next = parsePinnedObservationSource(source);
    if (!next || pinnedObservationSourceEquals(this.state.pinned, next)) return;
    this.state = { pinned: next, prepared: null };
    this.notify();
  }

  showPrepared(preview: PreparedMagnetizationPreview): void {
    this.state = { pinned: null, prepared: preview };
    this.notify();
  }

  clear(): void {
    if (!this.state.pinned && !this.state.prepared) return;
    this.state = EMPTY_OBSERVATION_SOURCE;
    this.notify();
  }

  clearForSession(identity: SessionResourceIdentity | null): void {
    const owner = this.state.pinned ?? this.state.prepared;
    if (owner && (!identity || owner.sessionIdentityKey !== sessionResourceIdentityKey(identity))) {
      this.clear();
    }
  }

  reset(): void {
    this.state = EMPTY_OBSERVATION_SOURCE;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function pinnedObservationSourceFromFrame(
  frame: ObservationFrameResource,
  identity: SessionResourceIdentity,
): PinnedObservationSource {
  return {
    acceptedRevision: frame.accepted_state_ref.generation.accepted_revision,
    acceptedStep: frame.accepted_state_ref.id.accepted_step,
    adapterId: frame.adapter_id,
    frameId: frame.frame_id,
    runId: frame.run_id,
    runtimeEpoch: frame.accepted_state_ref.generation.runtime_epoch,
    sessionIdentityKey: sessionResourceIdentityKey(identity),
    stageId: frame.stage_id,
    stateDigest: frame.accepted_state_ref.id.state_digest,
  };
}

export function pinnedObservationSourceEquals(
  left: PinnedObservationSource | null,
  right: PinnedObservationSource | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.acceptedRevision === right.acceptedRevision &&
      left.acceptedStep === right.acceptedStep &&
      left.adapterId === right.adapterId &&
      left.frameId === right.frameId &&
      left.runId === right.runId &&
      left.runtimeEpoch === right.runtimeEpoch &&
      left.sessionIdentityKey === right.sessionIdentityKey &&
      left.stageId === right.stageId &&
      left.stateDigest === right.stateDigest)
  );
}

function parsePinnedObservationSource(
  value: PinnedObservationSource | unknown,
): PinnedObservationSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<PinnedObservationSource>;
  if (
    !nonEmpty(source.adapterId) ||
    !nonEmpty(source.frameId) ||
    !nonEmpty(source.runId) ||
    !nonEmpty(source.sessionIdentityKey) ||
    !nonEmpty(source.stageId) ||
    !nonEmpty(source.stateDigest) ||
    !nonNegativeInteger(source.acceptedRevision) ||
    !nonNegativeInteger(source.acceptedStep) ||
    !nonNegativeInteger(source.runtimeEpoch)
  ) {
    return null;
  }
  return {
    acceptedRevision: source.acceptedRevision,
    acceptedStep: source.acceptedStep,
    adapterId: source.adapterId,
    frameId: source.frameId,
    runId: source.runId,
    runtimeEpoch: source.runtimeEpoch,
    sessionIdentityKey: source.sessionIdentityKey,
    stageId: source.stageId,
    stateDigest: source.stateDigest,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export const observationSourceWorkspaceStore =
  new ObservationSourceWorkspaceStore();

export function resetObservationSourceWorkspaceForTests(): void {
  observationSourceWorkspaceStore.reset();
}
