import type { DecodedComplexFieldVector, DecodedFieldVector } from "../api/codecs";
import type { FrequencyDomainFieldResource, ResourceRevision } from "../api/apiTypes";

import {
  type ModeFieldOverlayTopologyIdentity,
  type ModeFieldOverlayIntent,
  type ResolvedModeFieldOverlayMetadata,
  resolveModeFieldOverlayMetadata,
  validateModeFieldOverlayBinary,
} from "./ModeFieldOverlayIntent";

export type ModeFieldOverlayIntentStatus = "idle" | "loading" | "ready" | "error";

export interface ModeFieldOverlayIntentSnapshot {
  readonly binary: DecodedFieldVector | null;
  readonly error: Error | null;
  readonly field: DecodedComplexFieldVector | null;
  readonly intent: ModeFieldOverlayIntent | null;
  readonly metadata: ResolvedModeFieldOverlayMetadata | null;
  readonly phasorAmplitudeMax: number | null;
  readonly status: ModeFieldOverlayIntentStatus;
}

export interface ModeFieldOverlayMetadataLoadResult {
  readonly data: FrequencyDomainFieldResource;
  readonly revision: ResourceRevision | null;
}

export interface ModeFieldOverlayIntentLoaders {
  loadBinary: (
    metadata: ResolvedModeFieldOverlayMetadata,
    signal: AbortSignal,
  ) => Promise<DecodedFieldVector>;
  loadMetadata: (
    intent: ModeFieldOverlayIntent,
    signal: AbortSignal,
  ) => Promise<ModeFieldOverlayMetadataLoadResult>;
}

type ModeFieldOverlayIntentListener = () => void;

/**
 * Kernel-side abort/token boundary for mode handoff. The viewport can consume
 * only a `ready` snapshot; stale metadata or binary completions are dropped
 * before they reach an overlay/GPU owner.
 */
export class ModeFieldOverlayIntentController {
  private abortController: AbortController | null = null;
  private readonly listeners = new Set<ModeFieldOverlayIntentListener>();
  private requestToken = 0;
  private snapshot: ModeFieldOverlayIntentSnapshot = {
    binary: null,
    error: null,
    field: null,
    intent: null,
    metadata: null,
    phasorAmplitudeMax: null,
    status: "idle",
  };

  getSnapshot(): ModeFieldOverlayIntentSnapshot {
    return this.snapshot;
  }

  subscribe(listener: ModeFieldOverlayIntentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.requestToken += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.setSnapshot({
      binary: null,
      error: null,
      field: null,
      intent: null,
      metadata: null,
      phasorAmplitudeMax: null,
      status: "idle",
    });
  }

  async activate(
    intent: ModeFieldOverlayIntent,
    loaders: ModeFieldOverlayIntentLoaders,
    topology: ModeFieldOverlayTopologyIdentity,
  ): Promise<"cancelled" | "error" | "ready"> {
    const requestToken = ++this.requestToken;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setSnapshot({
      binary: null,
      error: null,
      field: null,
      intent,
      metadata: null,
      phasorAmplitudeMax: null,
      status: "loading",
    });

    try {
      const loadedMetadata = await loaders.loadMetadata(intent, abortController.signal);
      if (!this.isCurrent(requestToken, intent)) return "cancelled";
      const metadata = resolveModeFieldOverlayMetadata(
        intent,
        loadedMetadata.data,
        loadedMetadata.revision,
      );
      if (!metadata) {
        this.setError(requestToken, intent, "Mode field metadata failed validation.");
        return "error";
      }

      const binary = await loaders.loadBinary(metadata, abortController.signal);
      if (!this.isCurrent(requestToken, intent)) return "cancelled";
      const validated = validateModeFieldOverlayBinary(metadata, binary, topology);
      if (!validated) {
        this.setError(requestToken, intent, "Mode field binary payload failed validation.");
        return "error";
      }

      this.setSnapshot({
        binary: validated.binary,
        error: null,
        field: validated.complex,
        intent,
        metadata,
        phasorAmplitudeMax: validated.phasorAmplitudeMax,
        status: "ready",
      });
      return "ready";
    } catch (error) {
      if (!this.isCurrent(requestToken, intent)) return "cancelled";
      this.setError(
        requestToken,
        intent,
        error instanceof Error ? error.message : "Mode field request failed.",
      );
      return "error";
    } finally {
      if (this.requestToken === requestToken) {
        this.abortController = null;
      }
    }
  }

  private isCurrent(requestToken: number, intent: ModeFieldOverlayIntent): boolean {
    return this.requestToken === requestToken && this.snapshot.intent === intent;
  }

  private setError(
    requestToken: number,
    intent: ModeFieldOverlayIntent,
    message: string,
  ): void {
    if (!this.isCurrent(requestToken, intent)) return;
    this.setSnapshot({
      binary: null,
      error: new Error(message),
      field: null,
      intent,
      metadata: null,
      phasorAmplitudeMax: null,
      status: "error",
    });
  }

  private setSnapshot(next: ModeFieldOverlayIntentSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
