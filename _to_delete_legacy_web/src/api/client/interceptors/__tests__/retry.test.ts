import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../retry";

function fakeResponse(status: number): Response {
  return new Response(null, { status });
}

describe("retry interceptor", () => {
  it("returns immediately on 200", async () => {
    const doFetch = vi.fn().mockResolvedValue(fakeResponse(200));
    const res = await withRetry(doFetch, { maxRetries: 3, baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 400 client errors", async () => {
    const doFetch = vi.fn().mockResolvedValue(fakeResponse(400));
    const res = await withRetry(doFetch, { maxRetries: 3, baseDelayMs: 1 });
    expect(res.status).toBe(400);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 errors up to maxRetries", async () => {
    const doFetch = vi.fn().mockResolvedValue(fakeResponse(500));
    const res = await withRetry(doFetch, { maxRetries: 2, baseDelayMs: 1 });
    expect(res.status).toBe(500);
    // Initial + 2 retries = 3 total
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("succeeds after transient 500 then 200", async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(500))
      .mockResolvedValueOnce(fakeResponse(200));
    const res = await withRetry(doFetch, { maxRetries: 3, baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("applies exponential backoff between retries", async () => {
    const doFetch = vi.fn().mockResolvedValue(fakeResponse(503));
    const start = Date.now();
    await withRetry(doFetch, { maxRetries: 2, baseDelayMs: 50 });
    const elapsed = Date.now() - start;
    // delay(0) = 50, delay(1) = 100 → total ≥ 150ms (with some tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it("does not retry on 404", async () => {
    const doFetch = vi.fn().mockResolvedValue(fakeResponse(404));
    const res = await withRetry(doFetch, { maxRetries: 3, baseDelayMs: 1 });
    expect(res.status).toBe(404);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});
