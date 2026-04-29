import { describe, expect, it } from "vitest";
import {
  CONTEXT_LOSS_MAX_RETRIES,
  CONTEXT_LOSS_RETRY_DELAY_MS,
  CONTEXT_LOSS_RETRY_WINDOW_MS,
  resolveContextLossRecovery,
} from "../ScientificViewportShell";

describe("resolveContextLossRecovery", () => {
  it("allows bounded automatic retries with increasing delay", () => {
    const first = resolveContextLossRecovery({
      nowMs: 1_000,
      retryTimestamps: [],
    });

    expect(first.allowed).toBe(true);
    expect(first.nextTimestamps).toEqual([1_000]);
    expect(first.retryDelayMs).toBe(CONTEXT_LOSS_RETRY_DELAY_MS);

    const second = resolveContextLossRecovery({
      nowMs: 1_500,
      retryTimestamps: first.nextTimestamps,
    });

    expect(second.allowed).toBe(true);
    expect(second.nextTimestamps).toEqual([1_000, 1_500]);
    expect(second.retryDelayMs).toBe(CONTEXT_LOSS_RETRY_DELAY_MS * CONTEXT_LOSS_MAX_RETRIES);
  });

  it("blocks repeated context-loss remount loops inside the retry window", () => {
    const decision = resolveContextLossRecovery({
      nowMs: 2_000,
      retryTimestamps: [1_000, 1_500],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.nextTimestamps).toEqual([1_000, 1_500]);
    expect(decision.retryDelayMs).toBe(0);
  });

  it("drops old failures outside the retry window", () => {
    const nowMs = CONTEXT_LOSS_RETRY_WINDOW_MS + 5_000;
    const decision = resolveContextLossRecovery({
      nowMs,
      retryTimestamps: [1_000, 2_000],
    });

    expect(decision.allowed).toBe(true);
    expect(decision.nextTimestamps).toEqual([nowMs]);
  });
});
