import type { AntennaSourceSpectrumResource } from "@/kernel/api/apiTypes";

export interface SpectrumExportData {
  spectrum: AntennaSourceSpectrumResource;
  amplitudes: readonly number[];
  kU: readonly number[];
  kV: readonly number[];
  power: readonly number[];
}

/** Pull-based full-resolution JSON: the consumer owns backpressure and storage. */
export async function* spectrumExportChunks(source: SpectrumExportData, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted();
  yield '{"export_schema":"fullmag_source_spectrum_export.v1","manifest":';
  signal.throwIfAborted();
  yield JSON.stringify(source.spectrum);
  yield ',"data":{';
  const arrays = [
    ["k_u_rad_per_m", source.kU], ["k_v_rad_per_m", source.kV],
    ["amplitudes_re_im", source.amplitudes], ["power", source.power],
  ] as const;
  for (const [arrayIndex, [name, values]] of arrays.entries()) {
    signal.throwIfAborted();
    yield `${arrayIndex ? "," : ""}"${name}":[`;
    for (let offset = 0; offset < values.length; offset += 4096) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
      const chunk = JSON.stringify(values.slice(offset, offset + 4096));
      yield `${offset ? "," : ""}${chunk.slice(1, -1)}`;
    }
    yield "]";
  }
  signal.throwIfAborted();
  yield "}}\n";
}

/** Await every write; invalidation aborts even a currently pending sink write. */
export async function writeSpectrumExport(source: SpectrumExportData, writable: Pick<FileSystemWritableFileStream, "write" | "close" | "abort">, signal: AbortSignal): Promise<void> {
  const abort = () => { void writable.abort(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of spectrumExportChunks(source, signal)) {
      signal.throwIfAborted();
      await writable.write(chunk);
    }
    signal.throwIfAborted();
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
