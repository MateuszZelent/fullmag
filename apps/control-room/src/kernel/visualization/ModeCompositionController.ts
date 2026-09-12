import type { ResourceStatus } from "../resources/resourceTypes";
import type {
  EigenModeResourceRef as GeneratedEigenModeResourceRef,
  ModeCompositionDatasetPatch as GeneratedModeCompositionDatasetPatch,
  ModeCompositionLayer as GeneratedModeCompositionLayer,
  ModeCompositionLifecycle as GeneratedModeCompositionLifecycle,
  ModeCompositionOperation as GeneratedModeCompositionOperation,
  ModeCompositionPatch as GeneratedModeCompositionPatch,
  ModeCompositionPhaseClock as GeneratedModeCompositionPhaseClock,
  ModeCompositionResource as GeneratedModeCompositionResource,
  ModeFieldComponent as GeneratedModeFieldComponent,
  ModeFieldNormalization as GeneratedModeFieldNormalization,
  ModeFieldRepresentation as GeneratedModeFieldRepresentation,
  ModeLayerAnimation as GeneratedModeLayerAnimation,
  ModeLayerAppearance as GeneratedModeLayerAppearance,
} from "../api/apiTypes";

export type EigenModeResourceRef = GeneratedEigenModeResourceRef;
export type ModeCompositionDatasetPatch = GeneratedModeCompositionDatasetPatch;
export type ModeCompositionLayer = GeneratedModeCompositionLayer;
export type ModeCompositionLifecycle = GeneratedModeCompositionLifecycle;
export type ModeCompositionOperation = GeneratedModeCompositionOperation;
export type ModeCompositionPatch = GeneratedModeCompositionPatch;
export type ModeCompositionPhaseClock = GeneratedModeCompositionPhaseClock;
export type ModeCompositionResource = GeneratedModeCompositionResource;
export type ModeFieldComponent = GeneratedModeFieldComponent;
export type ModeFieldNormalization = GeneratedModeFieldNormalization;
export type ModeFieldRepresentation = GeneratedModeFieldRepresentation;
export type ModeLayerAnimation = GeneratedModeLayerAnimation;
export type ModeLayerAppearance = GeneratedModeLayerAppearance;

export interface ModeCompositionPatchIntent {
  readonly dataset?: ModeCompositionDatasetPatch;
  readonly operations: readonly ModeCompositionOperation[];
  readonly phase_clock?: ModeCompositionPhaseClock;
  /** Every affected target must be declared before an automatic 409 retry. */
  readonly target_ids: readonly string[];
}

export interface ModeCompositionMutationClient {
  getActiveModeComposition(options?: { signal?: AbortSignal }): Promise<ModeCompositionResource>;
  patchActiveModeComposition(
    patch: ModeCompositionPatch,
    options?: { signal?: AbortSignal },
  ): Promise<ModeCompositionResource>;
}

export type ModeCompositionMutationReasonCode =
  | "mode_composition_dataset_mismatch"
  | "mode_composition_lifecycle_reset"
  | "mode_composition_revision_conflict"
  | "mode_composition_unknown_error";

export class ModeCompositionMutationError extends Error {
  constructor(
    readonly reasonCode: ModeCompositionMutationReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "ModeCompositionMutationError";
  }
}

export interface ModeCompositionControllerSnapshot {
  readonly error: ModeCompositionMutationError | null;
  readonly pending_target_ids: readonly string[];
  readonly resource: ModeCompositionResource | null;
  readonly status: ResourceStatus;
}

type ModeCompositionListener = () => void;

interface PendingMutation {
  readonly baselineTargetFingerprints: ReadonlyMap<string, string | null>;
  cancelled: boolean;
  readonly epoch: number;
  readonly intent: ModeCompositionPatchIntent;
  readonly lifecycle: string;
  reject: (error: ModeCompositionMutationError) => void;
  resolve: (resource: ModeCompositionResource) => void;
}

/**
 * Keeps only ephemeral mutation state. The server resource remains authoritative:
 * a resource hook calls `acceptResource` after GET/realtime invalidation, while
 * this controller serializes PATCH requests and projects pending changes locally.
 */
export class ModeCompositionController {
  private authoritative: ModeCompositionResource | null = null;
  private epoch = 0;
  private lastError: ModeCompositionMutationError | null = null;
  private readonly listeners = new Set<ModeCompositionListener>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly pending: PendingMutation[] = [];
  private snapshot: ModeCompositionControllerSnapshot = {
    error: null,
    pending_target_ids: [],
    resource: null,
    status: "idle",
  };

  constructor(private readonly client: ModeCompositionMutationClient) {}

  getSnapshot(): ModeCompositionControllerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: ModeCompositionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Receives the revision-aware HTTP resource; realtime must only trigger its refetch. */
  acceptResource(resource: ModeCompositionResource | null): void {
    const lifecycleChanged =
      resource !== null &&
      this.authoritative !== null &&
      lifecycleKey(resource.lifecycle) !== lifecycleKey(this.authoritative.lifecycle);
    if (lifecycleChanged) {
      this.epoch += 1;
      this.cancelPendingForLifecycleReset();
    }
    this.authoritative = resource;
    this.lastError = null;
    this.publish();
  }

  assign(layer: ModeCompositionLayer): Promise<ModeCompositionResource> {
    const current = this.authoritative;
    const dataset = {
      artifact_revision: layer.mode.artifact_revision,
      run_id: layer.mode.run_id,
      stage_id: layer.mode.stage_id,
    };
    return this.mutate({
      ...(current && datasetMatches(current, dataset) ? {} : { dataset }),
      operations: [{ layer, op: "upsert_layer" }],
      target_ids: [layer.target_id],
    });
  }

  updateLayer(layer: ModeCompositionLayer): Promise<ModeCompositionResource> {
    return this.mutate({
      operations: [{ layer, op: "upsert_layer" }],
      target_ids: [layer.target_id],
    });
  }

  remove(layer: Pick<ModeCompositionLayer, "layer_id" | "target_id">): Promise<ModeCompositionResource> {
    return this.mutate({
      operations: [{ layer_id: layer.layer_id, op: "remove_layer" }],
      target_ids: [layer.target_id],
    });
  }

  setPhaseClock(phaseClock: ModeCompositionPhaseClock): Promise<ModeCompositionResource> {
    return this.mutate({
      operations: [],
      phase_clock: phaseClock,
      target_ids: [],
    });
  }

  mutate(intent: ModeCompositionPatchIntent): Promise<ModeCompositionResource> {
    const authoritative = this.authoritative;
    if (!authoritative) {
      return Promise.reject(
        new ModeCompositionMutationError(
          "mode_composition_lifecycle_reset",
          "Cannot change a mode composition before its active resource is ready.",
        ),
      );
    }
    const normalizedIntent = normalizeIntent(intent);
    const mutation = this.createPendingMutation(normalizedIntent, authoritative);
    this.pending.push(mutation);
    this.lastError = null;
    this.publish();

    this.mutationQueue = this.mutationQueue
      .then(() => this.execute(mutation))
      .catch(() => undefined);
    return new Promise<ModeCompositionResource>((resolve, reject) => {
      mutation.resolve = resolve;
      mutation.reject = reject;
    });
  }

  private createPendingMutation(
    intent: ModeCompositionPatchIntent,
    authoritative: ModeCompositionResource,
  ): PendingMutation {
    const fingerprints = new Map<string, string | null>();
    for (const targetId of intent.target_ids) {
      fingerprints.set(targetId, targetFingerprint(authoritative, targetId));
    }
    // Values are replaced synchronously before the mutation enters its queue.
    return {
      baselineTargetFingerprints: fingerprints,
      cancelled: false,
      epoch: this.epoch,
      intent,
      lifecycle: lifecycleKey(authoritative.lifecycle),
      reject: () => undefined,
      resolve: () => undefined,
    };
  }

  private async execute(mutation: PendingMutation): Promise<void> {
    if (mutation.cancelled || mutation.epoch !== this.epoch) return;
    const base = this.authoritative;
    if (!base) {
      this.rejectMutation(
        mutation,
        new ModeCompositionMutationError(
          "mode_composition_lifecycle_reset",
          "The active mode composition is no longer available.",
        ),
      );
      return;
    }

    try {
      const response = await this.client.patchActiveModeComposition(
        patchFor(base, mutation.intent),
      );
      if (!this.isCurrent(mutation)) return;
      this.acceptPatchResponse(mutation, response);
    } catch (error) {
      if (!this.isCurrent(mutation)) return;
      if (reasonCodeFromError(error) !== "mode_composition_revision_conflict") {
        this.rejectMutation(mutation, normalizeMutationError(error));
        return;
      }
      await this.retryAfterRevisionConflict(mutation);
    }
  }

  private async retryAfterRevisionConflict(mutation: PendingMutation): Promise<void> {
    try {
      const refreshed = await this.client.getActiveModeComposition();
      if (!this.isCurrent(mutation)) return;
      this.acceptResource(refreshed);
      if (!this.isCurrent(mutation) || !retryPreconditionsHold(refreshed, mutation)) {
        this.rejectMutation(
          mutation,
          new ModeCompositionMutationError(
            "mode_composition_revision_conflict",
            "The active composition changed for this target; refusing a last-write-wins retry.",
          ),
        );
        return;
      }
      const response = await this.client.patchActiveModeComposition(
        patchFor(refreshed, mutation.intent),
      );
      if (!this.isCurrent(mutation)) return;
      this.acceptPatchResponse(mutation, response);
    } catch (error) {
      if (!this.isCurrent(mutation)) return;
      this.rejectMutation(mutation, normalizeMutationError(error));
    }
  }

  private acceptPatchResponse(
    mutation: PendingMutation,
    response: ModeCompositionResource,
  ): void {
    this.authoritative = response;
    this.removePending(mutation);
    mutation.resolve(response);
    this.lastError = null;
    this.publish();
  }

  private rejectMutation(
    mutation: PendingMutation,
    error: ModeCompositionMutationError,
  ): void {
    if (mutation.cancelled) return;
    mutation.cancelled = true;
    this.removePending(mutation);
    this.lastError = error;
    mutation.reject(error);
    this.publish();
  }

  private removePending(mutation: PendingMutation): void {
    const index = this.pending.indexOf(mutation);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private cancelPendingForLifecycleReset(): void {
    for (const mutation of [...this.pending]) {
      mutation.cancelled = true;
      mutation.reject(
        new ModeCompositionMutationError(
          "mode_composition_lifecycle_reset",
          "The active composition lifecycle changed while the mutation was pending.",
        ),
      );
    }
    this.pending.length = 0;
  }

  private isCurrent(mutation: PendingMutation): boolean {
    return !mutation.cancelled && mutation.epoch === this.epoch;
  }

  private publish(): void {
    const resource = this.authoritative
      ? projectPendingMutations(this.authoritative, this.pending)
      : null;
    this.snapshot = {
      error: this.lastError,
      pending_target_ids: uniquePendingTargetIds(this.pending),
      resource,
      status: this.lastError
        ? "error"
        : this.pending.length > 0
          ? "stale"
          : resource
            ? "ready"
            : "idle",
    };
    for (const listener of this.listeners) listener();
  }
}

function normalizeIntent(intent: ModeCompositionPatchIntent): ModeCompositionPatchIntent {
  return {
    ...(intent.dataset ? { dataset: { ...intent.dataset } } : {}),
    operations: intent.operations.map((operation) =>
      operation.op === "upsert_layer"
        ? { layer: cloneLayer(operation.layer), op: "upsert_layer" as const }
        : operation.op === "remove_layer"
          ? { layer_id: operation.layer_id, op: "remove_layer" as const }
          : { op: "clear_layers" as const },
    ),
    ...(intent.phase_clock ? { phase_clock: { ...intent.phase_clock } } : {}),
    target_ids: [...new Set(intent.target_ids)],
  };
}

function patchFor(
  resource: ModeCompositionResource,
  intent: ModeCompositionPatchIntent,
): ModeCompositionPatch {
  return {
    base_revision: resource.revision,
    ...(intent.dataset ? { dataset: intent.dataset } : {}),
    operations: [...intent.operations],
    ...(intent.phase_clock ? { phase_clock: intent.phase_clock } : {}),
  };
}

function projectPendingMutations(
  resource: ModeCompositionResource,
  pending: readonly PendingMutation[],
): ModeCompositionResource {
  return pending.reduce(
    (current, mutation) =>
      mutation.cancelled ? current : applyIntent(current, mutation.intent),
    resource,
  );
}

function applyIntent(
  resource: ModeCompositionResource,
  intent: ModeCompositionPatchIntent,
): ModeCompositionResource {
  const layers = resource.layers.map(cloneLayer);
  for (const operation of intent.operations) {
    if (operation.op === "clear_layers") {
      layers.length = 0;
    } else if (operation.op === "remove_layer") {
      const index = layers.findIndex((layer) => layer.layer_id === operation.layer_id);
      if (index >= 0) layers.splice(index, 1);
    } else {
      const index = layers.findIndex(
        (layer) =>
          layer.layer_id === operation.layer.layer_id ||
          layer.target_id === operation.layer.target_id,
      );
      if (index >= 0) layers.splice(index, 1, cloneLayer(operation.layer));
      else layers.push(cloneLayer(operation.layer));
    }
  }
  return {
    ...resource,
    ...(intent.dataset ?? {}),
    layers,
    ...(intent.phase_clock ? { phase_clock: { ...intent.phase_clock } } : {}),
  };
}

function cloneLayer(layer: ModeCompositionLayer): ModeCompositionLayer {
  return {
    ...layer,
    animation: { ...layer.animation },
    appearance: { ...layer.appearance },
    mode: { ...layer.mode },
  };
}

function targetFingerprint(
  resource: ModeCompositionResource | null,
  targetId: string,
): string | null {
  const layer = resource?.layers.find((candidate) => candidate.target_id === targetId);
  return layer ? JSON.stringify(layer) : null;
}

function retryPreconditionsHold(
  resource: ModeCompositionResource,
  mutation: PendingMutation,
): boolean {
  return (
    lifecycleKey(resource.lifecycle) === mutation.lifecycle &&
    [...mutation.baselineTargetFingerprints].every(
      ([targetId, fingerprint]) => targetFingerprint(resource, targetId) === fingerprint,
    )
  );
}

function lifecycleKey(lifecycle: ModeCompositionLifecycle): string {
  return `${lifecycle.session_id}\u0000${lifecycle.run_id ?? ""}\u0000${lifecycle.artifact_revision}\u0000${lifecycle.mesh_revision}`;
}

function datasetMatches(
  resource: ModeCompositionResource,
  dataset: ModeCompositionDatasetPatch,
): boolean {
  return (
    resource.run_id === dataset.run_id &&
    resource.stage_id === dataset.stage_id &&
    resource.artifact_revision === dataset.artifact_revision
  );
}

function uniquePendingTargetIds(pending: readonly PendingMutation[]): string[] {
  return [...new Set(pending.flatMap((mutation) => mutation.intent.target_ids))];
}

function reasonCodeFromError(error: unknown): ModeCompositionMutationReasonCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("mode_composition_revision_conflict")) {
    return "mode_composition_revision_conflict";
  }
  if (message.includes("mode_composition_dataset_mismatch")) {
    return "mode_composition_dataset_mismatch";
  }
  return "mode_composition_unknown_error";
}

function normalizeMutationError(error: unknown): ModeCompositionMutationError {
  if (error instanceof ModeCompositionMutationError) return error;
  const message = error instanceof Error ? error.message : "Mode composition mutation failed.";
  return new ModeCompositionMutationError(reasonCodeFromError(error), message);
}
