/** Cap a binary body before the generated transport allocates its ArrayBuffer. */
export function boundedBinaryResponse(response: Response, limit?: number): Response {
  if (limit === undefined || !response.ok || response.status === 204) return response;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    void response.body?.cancel();
    throw new Error("Binary response byte limit must be a positive safe integer.");
  }
  // Fetch exposes decoded bytes. A compressed Content-Length describes the
  // wire representation and cannot validate the length of this stream.
  const encoding = response.headers.get("content-encoding");
  const declared = encoding && encoding.toLowerCase() !== "identity"
    ? null : response.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(limit))) {
    void response.body?.cancel();
    throw new Error("Binary response exceeds its declared byte budget.");
  }
  if (!response.body) throw new Error("Expected a bounded binary response body.");
  const reader = response.body.getReader();
  let received = 0;
  let bodyError: unknown;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (declared !== null && BigInt(received) !== BigInt(declared)) {
            throw new Error("Binary body length differs from Content-Length.");
          }
          controller.close();
          reader.releaseLock();
          return;
        }
        received += next.value.byteLength;
        if (received > limit) throw new Error("Binary response exceeds its streaming byte budget.");
        controller.enqueue(next.value);
      } catch (error) {
        bodyError = error;
        controller.error(error);
        await reader.cancel(error).catch(() => undefined);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
    },
  }, { highWaterMark: 0 });
  const bounded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  const arrayBuffer = bounded.arrayBuffer.bind(bounded);
  // Chrome's native body consumption may replace a stream error with
  // TypeError("Failed to fetch"). Keep the actual cause for the generated
  // transport's parseAs: "arrayBuffer" path without changing the byte cap.
  bounded.arrayBuffer = async () => {
    if (bounded.bodyUsed) return arrayBuffer();
    try {
      return await arrayBuffer();
    } catch (error) {
      throw bodyError ?? error;
    }
  };
  return bounded;
}
