import type { ResultsSource } from "@/kernel/api/resultsBrowser";
import type {
  SnapshotVisualizationAppearance,
  SnapshotVisualizationIdentity,
} from "@/kernel/visualization/SnapshotVisualizationController";

/** Identity of one dataset/quantity series, excluding the sample index. */
export interface ResultsSnapshotFrameSeriesIdentity {
  readonly sessionIdentityKey: string | null;
  readonly source: ResultsSource;
  readonly identity: SnapshotVisualizationIdentity;
}

/** The bounded render-side state kept while the next sample is loading. */
export interface RetainedResultsSnapshotFrame {
  readonly seriesKey: string;
  readonly appearanceKey: string;
  readonly sampleIndex: number;
  readonly coordinateCaption: string;
  readonly legendComponent: string;
  readonly palette: string;
  readonly colors: Float32Array;
  readonly range: { readonly min: number; readonly max: number };
}

/** One-frame external store; the render buffer never enters React state. */
export class ResultsSnapshotFrameRetentionStore {
  private frame: RetainedResultsSnapshotFrame | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): RetainedResultsSnapshotFrame | null => this.frame;
  readonly getServerSnapshot = (): RetainedResultsSnapshotFrame | null => null;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  commit(frame: RetainedResultsSnapshotFrame): void {
    this.frame = frame;
    this.notify();
  }

  clear(): void {
    if (this.frame === null) return;
    this.frame = null;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * A sample change within one exact series may reuse the last ready colors.
 * Session/source/run/stage/dataset/quantity/revision are all part of the key;
 * the sample index deliberately is not.
 */
export function resultsSnapshotFrameSeriesKey(
  value: ResultsSnapshotFrameSeriesIdentity,
): string {
  return JSON.stringify([
    value.sessionIdentityKey,
    value.source.kind,
    value.source.kind === "workspace" ? value.source.itemId : null,
    value.identity.runId,
    value.identity.stageId,
    value.identity.datasetId,
    value.identity.quantityId,
    value.identity.revision,
  ]);
}

/** Preserve the appearance metadata that was used to produce a retained frame. */
export function resultsSnapshotFrameAppearanceKey(
  appearance: SnapshotVisualizationAppearance,
): string {
  return JSON.stringify([
    appearance.component,
    appearance.palette,
    appearance.visible,
    appearance.rangeMode,
    appearance.min,
    appearance.max,
  ]);
}

export function canUseRetainedResultsSnapshotFrame(
  frame: RetainedResultsSnapshotFrame | null,
  seriesKey: string | null,
  visible: boolean,
  requestedSampleIndex: number,
): frame is RetainedResultsSnapshotFrame {
  return (
    visible &&
    frame !== null &&
    seriesKey !== null &&
    frame.seriesKey === seriesKey &&
    frame.sampleIndex !== requestedSampleIndex &&
    frame.colors.length > 0
  );
}
