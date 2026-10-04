import type { ObservationFrameResource } from "../api/apiTypes";
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

export interface ObservationSourceWorkspaceState {
  pinned: PinnedObservationSource | null;
}

type ObservationSourceWorkspaceListener = () => void;

const INITIAL_STATE: ObservationSourceWorkspaceState = { pinned: null };

class ObservationSourceWorkspaceStore {
  private readonly listeners = new Set<ObservationSourceWorkspaceListener>();
  private state = INITIAL_STATE;

  getSnapshot = (): ObservationSourceWorkspaceState => this.state;

  subscribe = (listener: ObservationSourceWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  pin(source: PinnedObservationSource): void {
    const next = parsePinnedObservationSource(source);
    if (!next || pinnedObservationSourceEquals(this.state.pinned, next)) return;
    this.state = { pinned: next };
    this.notify();
  }

  clear(): void {
    if (!this.state.pinned) return;
    this.state = INITIAL_STATE;
    this.notify();
  }

  clearForSession(identity: SessionResourceIdentity | null): void {
    if (
      !this.state.pinned ||
      (identity &&
        this.state.pinned.sessionIdentityKey === sessionResourceIdentityKey(identity))
    ) {
      return;
    }
    this.clear();
  }

  reset(): void {
    this.state = INITIAL_STATE;
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
