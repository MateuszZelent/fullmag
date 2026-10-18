"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { downloadChartBlob } from "@/shared/analysis-charts/chartExport";
import { Button } from "@/shared/ui/Button";

import { spectrumExportChunks, writeSpectrumExport, type SpectrumExportData } from "./AntennaSpectrumExportModel";

/** Compatibility download when a direct file writer is unavailable. */
async function spectrumExportBlob(source: SpectrumExportData, signal: AbortSignal): Promise<Blob> {
  const parts: BlobPart[] = [];
  for await (const chunk of spectrumExportChunks(source, signal)) parts.push(new Blob([chunk]));
  signal.throwIfAborted();
  return new Blob(parts, { type: "application/json" });
}

type SpectrumSaveWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>;
};

export function AntennaSpectrumExport(props: SpectrumExportData) {
  const { spectrum, amplitudes, kU, kV, power } = props;
  const job = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => () => { job.current?.abort(); }, [spectrum, amplitudes, kU, kV, power]);

  const exportData = async () => {
    if (job.current && !job.current.signal.aborted) return;
    const controller = new AbortController();
    job.current = controller;
    setPending(true);
    setFailed(false);
    try {
      const id = spectrum.output_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "output";
      const filename = `antenna-spectrum-${id}.json`;
      const picker = (window as SpectrumSaveWindow).showSaveFilePicker;
      if (picker) {
        // Invoke before yielding so the browser retains the click activation.
        let handle: FileSystemFileHandle;
        try {
          handle = await picker.call(window, { suggestedName: filename, types: [{ description: "Spectrum JSON", accept: { "application/json": [".json"] } }] });
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          throw error;
        }
        controller.signal.throwIfAborted();
        const writable = await handle.createWritable();
        await writeSpectrumExport(props, writable, controller.signal);
      } else {
        const content = await spectrumExportBlob(props, controller.signal);
        controller.signal.throwIfAborted();
        if (!downloadChartBlob({ content, filename, mimeType: "application/json" })) setFailed(true);
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (job.current === controller) {
        job.current = null;
        setPending(false);
      }
    }
  };

  return <>
    <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => { void exportData(); }}>
      {pending ? "Preparing spectrum…" : "Export full spectrum (JSON)"}
    </Button>
    {failed ? <p role="alert">Spectrum export failed. Try again.</p> : null}
  </>;
}
