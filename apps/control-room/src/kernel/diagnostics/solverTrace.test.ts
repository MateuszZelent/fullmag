import { describe, expect, it } from "vitest";

import type { SolverProfileResource } from "../api/apiTypes";

import {
  createSolverTraceObserver,
  type SolverTraceResource,
} from "./solverTrace";

const SERVER_SEGMENT_IDS = [
  "native_to_runner_callback_ns",
  "runner_callback_to_publisher_enqueue_ns",
  "publisher_queue_ns",
  "publisher_apply_ns",
  "api_revision_visibility_ns",
] as const;

function traceFor(value: string, completeServer = false): SolverTraceResource {
  const segments = completeServer
    ? Object.fromEntries(
        SERVER_SEGMENT_IDS.map((id, index) => [
          id,
          {
            clock_domain: "server_monotonic" as const,
            duration_ns: index + 1,
            kind: id.replace(/_ns$/, "") as
              | "native_to_runner_callback"
              | "runner_callback_to_publisher_enqueue"
              | "publisher_queue"
              | "publisher_apply"
              | "api_revision_visibility",
          },
        ]),
      )
    : {};
  return {
    api_revision: null,
    completeness: completeServer ? "partial" : "server_only",
    format: "fullmag.solver_trace.v1",
    segments,
    trace_id: {
      accepted_step: 1,
      run_generation: "run",
      sample_sequence: 1,
      stage_sequence: 0,
      value,
    },
    unaccounted_browser_ns: 0,
    unaccounted_server_ns: 0,
  };
}

function profileWithTraces(
  ...traces: Array<SolverTraceResource | null>
): SolverProfileResource {
  return {
    latest_samples: traces.map((trace, index) => ({
      step: index + 1,
      trace,
    })) as SolverProfileResource["latest_samples"],
  } as SolverProfileResource;
}

describe("solver trace observer", () => {
  it("measures fetch, decode-to-commit, and the next animation frame only for sampled IDs", () => {
    let frameCallback: ((timestampMs: number) => void) | undefined;
    const observer = createSolverTraceObserver({
      now: () => 21,
      requestAnimationFrame: (callback) => {
        frameCallback = callback;
        return "frame";
      },
    });
    const sampled = profileWithTraces(traceFor("sampled"));
    const unsampled = profileWithTraces(null);

    observer.observeProfileLoad(sampled, 10, 20);
    observer.observeProfileLoad(unsampled, 20, 30);
    observer.observeProfileCommit(sampled, 22);

    expect(observer.observation("sampled")).toEqual({
      browserSegments: {
        browser_decode_to_commit: {
          clock_domain: "browser_performance",
          duration_ns: 2_000_000,
          kind: "browser_decode_to_commit",
        },
        browser_fetch: {
          clock_domain: "browser_performance",
          duration_ns: 10_000_000,
          kind: "browser_fetch",
        },
      },
      traceId: "sampled",
    });
    expect(observer.observations()).toHaveLength(1);
    expect(frameCallback).toBeDefined();

    frameCallback?.(25);

    const merged = observer.mergeProfile(sampled);
    const mergedTrace = merged?.latest_samples[0]?.trace;
    expect(mergedTrace?.segments.browser_fetch_ns?.duration_ns).toBe(10_000_000);
    expect(
      mergedTrace?.segments.browser_decode_to_commit_ns?.duration_ns,
    ).toBe(2_000_000);
    expect(
      mergedTrace?.segments.commit_to_animation_frame_ns?.duration_ns,
    ).toBe(3_000_000);
    expect(mergedTrace?.completeness).toBe("partial");
    expect(observer.observation("unsampled")).toBeUndefined();
  });

  it("bounds trace state and does not schedule idle animation work", () => {
    let frameRequests = 0;
    const observer = createSolverTraceObserver({
      maxTraces: 2,
      requestAnimationFrame: () => {
        frameRequests += 1;
        return undefined;
      },
    });

    observer.observeProfileLoad(profileWithTraces(traceFor("a")), 0, 1);
    observer.observeProfileLoad(profileWithTraces(traceFor("b")), 1, 2);
    observer.observeProfileLoad(profileWithTraces(traceFor("c")), 2, 3);

    expect(observer.observations().map(({ traceId }) => traceId)).toEqual([
      "b",
      "c",
    ]);
    expect(frameRequests).toBe(0);

    observer.observeProfileCommit(profileWithTraces(traceFor("b")), 4);
    expect(frameRequests).toBe(1);
  });

  it("attributes a profile response to its newest sampled record, not history", () => {
    const observer = createSolverTraceObserver();
    observer.observeProfileLoad(
      profileWithTraces(traceFor("historical"), traceFor("newest")),
      10,
      20,
    );

    expect(observer.observation("historical")).toBeUndefined();
    expect(observer.observation("newest")).toBeDefined();
  });

  it("merges browser segments with a complete server trace without overwriting server data", () => {
    let frameCallback: ((timestampMs: number) => void) | undefined;
    const observer = createSolverTraceObserver({
      requestAnimationFrame: (callback) => {
        frameCallback = callback;
        return undefined;
      },
    });
    const profile = profileWithTraces(traceFor("complete", true));

    observer.observeProfileLoad(profile, 10, 20);
    observer.observeProfileCommit(profile, 21);
    frameCallback?.(22);

    const merged = observer.mergeTrace(profile.latest_samples[0]!.trace!);
    expect(merged.completeness).toBe("complete");
    expect(merged.segments.native_to_runner_callback_ns?.duration_ns).toBe(1);
    expect(merged.segments.browser_fetch_ns?.duration_ns).toBe(10_000_000);
  });
});
