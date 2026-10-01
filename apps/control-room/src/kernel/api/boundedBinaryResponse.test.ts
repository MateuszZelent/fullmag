import { describe, expect, it } from "vitest";
import { boundedBinaryResponse } from "./boundedBinaryResponse";

describe("bounded binary transport body", () => {
  it("preserves a complete body inside the cap", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
    expect([...new Uint8Array(await boundedBinaryResponse(response, 3).arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rejects an oversized declared body before reading it", () => {
    expect(() => boundedBinaryResponse(new Response(new Uint8Array(4), { headers: { "content-length": "4" } }), 3)).toThrow(/budget/);
  });

  it("rejects chunked overflow and cancels the source", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() { cancelled = true; },
    }));
    await expect(boundedBinaryResponse(response, 3).arrayBuffer()).rejects.toThrow(/budget/);
    expect(cancelled).toBe(true);
  });

  it("rejects a body shorter than its declared length", async () => {
    await expect(boundedBinaryResponse(new Response(new Uint8Array(2), { headers: { "content-length": "3" } }), 3).arrayBuffer()).rejects.toThrow(/Content-Length/);
  });

  it("caps decoded bytes without comparing a compressed wire length", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "1", "content-encoding": "gzip" } });
    expect((await boundedBinaryResponse(response, 3).arrayBuffer()).byteLength).toBe(3);
  });

  it("keeps error and conditional responses on the existing transport path", () => {
    for (const response of [new Response(null, { status: 304 }), new Response("error", { status: 500 })]) {
      expect(boundedBinaryResponse(response, 3)).toBe(response);
    }
  });
});
