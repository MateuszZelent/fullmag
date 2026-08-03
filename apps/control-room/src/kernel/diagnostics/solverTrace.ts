import type { SolverProfileResource } from "../api/apiTypes";

export type SolverTraceResource = NonNullable<
  NonNullable<SolverProfileResource["latest_samples"][number]["trace"]>
>;
type SolverTraceSegment = SolverTraceResource["segments"][string];
type SolverTraceSegmentKind = SolverTraceSegment["kind"];

const SERVER_TRACE_SEGMENT_IDS = [
  "native_to_runner_callback_ns",
  "runner_callback_to_publisher_enqueue_ns",
  "publisher_queue_ns",
  "publisher_apply_ns",
  "api_revision_visibility_ns",
] as const;
const BROWSER_TRACE_SEGMENT_IDS = [
  "browser_fetch_ns",
  "browser_decode_to_commit_ns",
  "commit_to_animation_frame_ns",
] as const;
const DEFAULT_MAX_TRACES = 64;
const MAX_TRACE_ID_LENGTH = 192;

export type SolverTraceProfileSample =
  SolverProfileResource["latest_samples"][number];

export interface SolverTraceObserverOptions {
  maxTraces?: number;
  now?: () => number;
  requestAnimationFrame?: SolverTraceAnimationFrameScheduler | null;
}

export type SolverTraceAnimationFrameScheduler = (
  callback: (timestampMs: number) => void,
) => unknown;

export interface SolverTraceObservation {
  traceId: string;
  browserSegments: Readonly<
    Partial<Record<SolverTraceSegmentKind, SolverTraceSegment>>
  >;
}

export interface SolverTraceObserver {
  observeProfileLoad(
    profile: SolverProfileResource | null | undefined,
    startedAtMs: number,
    resolvedAtMs: number,
  ): void;
  observeProfileCommit(
    profile: SolverProfileResource | null | undefined,
    committedAtMs?: number,
  ): void;
  observation(traceId: string): SolverTraceObservation | undefined;
  observations(): readonly SolverTraceObservation[];
  mergeTrace(trace: SolverTraceResource): SolverTraceResource;
  mergeProfile(
    profile: SolverProfileResource | null | undefined,
  ): SolverProfileResource | null | undefined;
}

export function solverTraceNow(): number {
  return defaultNow();
}

interface MutableObservation {
  browserSegments: Partial<
    Record<SolverTraceSegmentKind, SolverTraceSegment>
  >;
  commitAtMs?: number;
  responseAtMs?: number;
  traceId: string;
}

/**
 * Creates a bounded, event-driven browser half of the solver trace.
 *
 * The observer does not poll.  A fetch observation is accepted only when the
 * response contains a sampled server trace ID; commit and animation-frame
 * observations are then scheduled for that same ID.  The scheduler and clock
 * are injected so tests can be deterministic without a browser runtime.
 */
export function createSolverTraceObserver({
  maxTraces = DEFAULT_MAX_TRACES,
  now = defaultNow,
  requestAnimationFrame = defaultRequestAnimationFrame(),
}: SolverTraceObserverOptions = {}): SolverTraceObserver {
  const boundedMaxTraces = normalizeMaxTraces(maxTraces);
  const entries = new Map<string, MutableObservation>();

  const ensureObservation = (traceId: string): MutableObservation | null => {
    if (!isUsableTraceId(traceId)) return null;
    const existing = entries.get(traceId);
    if (existing) return existing;
    if (entries.size >= boundedMaxTraces) {
      const oldest = entries.keys().next().value;
      if (typeof oldest === "string") entries.delete(oldest);
    }
    const created: MutableObservation = { browserSegments: {}, traceId };
    entries.set(traceId, created);
    return created;
  };

  const observeProfileLoad = (
    profile: SolverProfileResource | null | undefined,
    startedAtMs: number,
    resolvedAtMs: number,
  ): void => {
    const durationNs = durationToNanoseconds(resolvedAtMs - startedAtMs);
    if (durationNs === null) return;
    for (const sample of tracedSamples(profile)) {
      const traceId = sample.trace?.trace_id.value;
      if (!traceId) continue;
      const observation = ensureObservation(traceId);
      if (!observation) continue;
      observation.responseAtMs ??= resolvedAtMs;
      addBrowserSegment(observation, "browser_fetch", durationNs);
    }
  };

  const observeProfileCommit = (
    profile: SolverProfileResource | null | undefined,
    committedAtMs = now(),
  ): void => {
    if (!Number.isFinite(committedAtMs)) return;
    for (const sample of tracedSamples(profile)) {
      const traceId = sample.trace?.trace_id.value;
      if (!traceId) continue;
      const observation = entries.get(traceId);
      if (!observation || observation.commitAtMs !== undefined) continue;
      const responseAtMs = observation.responseAtMs;
      if (responseAtMs === undefined) continue;
      const decodeToCommitNs = durationToNanoseconds(
        committedAtMs - responseAtMs,
      );
      if (decodeToCommitNs === null) continue;
      observation.commitAtMs = committedAtMs;
      addBrowserSegment(
        observation,
        "browser_decode_to_commit",
        decodeToCommitNs,
      );
      scheduleAnimationFrame(observation);
    }
  };

  const scheduleAnimationFrame = (observation: MutableObservation): void => {
    if (!requestAnimationFrame) return;
    const commitAtMs = observation.commitAtMs;
    if (commitAtMs === undefined) return;
    requestAnimationFrame((frameAtMs) => {
      const current = entries.get(observation.traceId);
      if (!current || current !== observation) return;
      if (current.browserSegments.commit_to_animation_frame) return;
      const durationNs = durationToNanoseconds(frameAtMs - commitAtMs);
      if (durationNs === null) return;
      addBrowserSegment(current, "commit_to_animation_frame", durationNs);
    });
  };

  return {
    mergeProfile(profile) {
      if (!profile) return profile;
      return {
        ...profile,
        latest_samples: profile.latest_samples.map((sample) =>
          sample.trace
            ? {
                ...sample,
                trace: mergeTraceWithObservation(
                  sample.trace,
                  entries.get(sample.trace.trace_id.value),
                ),
              }
            : sample,
        ),
      };
    },
    mergeTrace(trace) {
      return mergeTraceWithObservation(trace, entries.get(trace.trace_id.value));
    },
    observation(traceId) {
      const observation = entries.get(traceId);
      return observation ? freezeObservation(observation) : undefined;
    },
    observations() {
      return Array.from(entries.values(), freezeObservation);
    },
    observeProfileCommit,
    observeProfileLoad,
  };
}

function addBrowserSegment(
  observation: MutableObservation,
  kind: SolverTraceSegmentKind,
  durationNs: number,
): void {
  if (observation.browserSegments[kind]) return;
  observation.browserSegments[kind] = {
    clock_domain: "browser_performance",
    duration_ns: durationNs,
    kind,
  };
}

function freezeObservation(
  observation: MutableObservation,
): SolverTraceObservation {
  return {
    browserSegments: Object.freeze({ ...observation.browserSegments }),
    traceId: observation.traceId,
  };
}

function mergeTraceWithObservation(
  trace: SolverTraceResource,
  observation: MutableObservation | undefined,
): SolverTraceResource {
  if (!observation) return trace;
  const segments = { ...trace.segments };
  for (const [kind, segment] of Object.entries(observation.browserSegments)) {
    if (segment) {
      const id = segmentIdForKind(kind as SolverTraceSegmentKind);
      segments[id] ??= segment;
    }
  }
  return {
    ...trace,
    completeness: resolveCompleteness(trace, segments),
    segments,
  };
}

function resolveCompleteness(
  trace: SolverTraceResource,
  segments: SolverTraceResource["segments"],
): SolverTraceResource["completeness"] {
  const allSegmentIds = [...SERVER_TRACE_SEGMENT_IDS, ...BROWSER_TRACE_SEGMENT_IDS];
  if (allSegmentIds.every((id) => id in segments)) return "complete";
  if (Object.keys(segments).length > 0 || trace.api_revision != null) {
    return "partial";
  }
  return trace.completeness;
}

function segmentIdForKind(kind: SolverTraceSegmentKind): string {
  switch (kind) {
    case "browser_fetch":
      return "browser_fetch_ns";
    case "browser_decode_to_commit":
      return "browser_decode_to_commit_ns";
    case "commit_to_animation_frame":
      return "commit_to_animation_frame_ns";
    default:
      return kind;
  }
}

function tracedSamples(
  profile: SolverProfileResource | null | undefined,
): readonly SolverTraceProfileSample[] {
  // A profile response contains a bounded history.  Attribute the request and
  // commit clock only to the newest sampled record; assigning one HTTP span to
  // every historical trace would make old solver steps look freshly fetched.
  const samples = profile?.latest_samples;
  const latest = samples?.[samples.length - 1];
  return latest?.trace ? [latest] : [];
}

function durationToNanoseconds(durationMs: number): number | null {
  if (!Number.isFinite(durationMs)) return null;
  return Math.max(0, Math.round(durationMs * 1_000_000));
}

function normalizeMaxTraces(maxTraces: number): number {
  if (!Number.isFinite(maxTraces)) return DEFAULT_MAX_TRACES;
  return Math.max(1, Math.min(DEFAULT_MAX_TRACES, Math.floor(maxTraces)));
}

function isUsableTraceId(traceId: string): boolean {
  return traceId.length > 0 && traceId.length <= MAX_TRACE_ID_LENGTH;
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function defaultRequestAnimationFrame(): SolverTraceAnimationFrameScheduler | null {
  const requestAnimationFrame = globalThis.requestAnimationFrame;
  return typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame.call(globalThis, callback)
    : null;
}
