"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import {
  type Export3DFormat,
  type Export3DResult,
} from "@/shared/export-3d/export3dTypes";

import type { Viewport3DExportSource } from "./extractViewport3DExportSource";
import { viewport3dStore } from "../viewport3dStore";

export type ViewportModelSource = Pick<
  Viewport3DExportSource,
  "defaultColorMode" | "defaultPalette" | "provenance" | "quantityId" |
  "sourceLabel" | "suggestedFilenameStem" | "targets" | "warnings"
>;

const FORMATS = {
  glb: "GLB (.glb)",
  gltf: "glTF (.gltf)",
  vtu: "VTK Unstructured Grid (.vtu)",
  vtu_zip: "ParaView archive (.vtu.zip)",
} satisfies Record<Export3DFormat, string>;

function downloadModel(result: Export3DResult) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export default function Viewport3DExportDialog({ getSource }: { getSource: () => Promise<ViewportModelSource> }) {
  // Keep the opening view while the extraction module loads.
  const [snapshot] = useState(() => getSource);
  const [source, setSource] = useState<ViewportModelSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [format, setFormat] = useState<Export3DFormat>("glb");
  const [filename, setFilename] = useState("");
  const [includeVectors, setIncludeVectors] = useState(false);
  useEffect(() => {
    let active = true;
    void snapshot().then((next) => {
      if (!active) return;
      setSource(next);
      setFilename(next.suggestedFilenameStem);
      setIncludeVectors(next.targets.some((target) =>
        target.role !== "airbox" && target.field?.componentCount === 3 && target.appearance?.includeVectors,
      ));
    }).catch((error: unknown) => {
      if (active) setSourceError(error instanceof Error ? error.message : "Could not read the current 3D view.");
    });
    return () => { active = false; };
  }, [snapshot]);
  const [includeAirbox, setIncludeAirbox] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useRef<AbortController | null>(null);
  useEffect(() => () => job.current?.abort(), []);

  const vtk = format === "vtu" || format === "vtu_zip";
  const hasAirbox = source?.targets.some((target) => target.role === "airbox") ?? false;
  const targets = source?.targets.filter((target) => includeAirbox || target.role !== "airbox") ?? [];
  const hasVectors = targets.some((target) => target.field?.componentCount === 3);
  const canAnimate = format !== "vtu" && targets.some(({ field }) =>
    field?.kind === "complex" && (field.complexRepresentation ?? "phase_rotated_real") === "phase_rotated_real",
  );

  async function onExport() {
    if (!source || job.current || targets.length === 0) return;
    const controller = new AbortController();
    job.current = controller;
    setError(null);
    setExporting(true);
    try {
      const { export3DModel } = await import("@/shared/export-3d");
      const result = await export3DModel({
        targets: targets.map((target) => ({
          ...target,
          appearance: {
            ...target.appearance,
            includeVectors: includeVectors && target.field?.componentCount === 3,
            includeSurface: target.appearance?.includeSurface || !target.appearance?.includeWireframe,
          },
        })),
        options: {
          format,
          filename,
          animationMode: animate && canAnimate ? "phase_cycle" : "static",
          vtkIncludeVectorData: includeVectors,
          colorMode: source.defaultColorMode,
          colorPalette: source.defaultPalette,
          provenance: { ...source.provenance, quantity_id: source.quantityId },
          signal: controller.signal,
        },
      });
      if (!controller.signal.aborted) {
        downloadModel(result);
        viewport3dStore.setExport3DDialogOpen(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Could not export the 3D model.");
      }
    } finally {
      job.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => viewport3dStore.setExport3DDialogOpen(open)}>
      <DialogContent className="fm-export-3d-dialog">
        <DialogHeader>
          <DialogTitle>Export 3D model</DialogTitle>
          <DialogDescription>
            {source ? [source.sourceLabel, source.quantityId].filter((label, i, labels) => label && labels.indexOf(label) === i).join(" · ") : "Current 3D view"}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-export-3d-dialog__body">
          {source ? (
            <>
              <div className="fm-export-3d-dialog__grid">
                <label className="fm-export-3d-dialog__field">
                  <span className="fm-export-3d-dialog__label">Format</span>
                  <select className="fm-export-3d-dialog__input" value={format} disabled={exporting}
                    onChange={(event) => setFormat(event.currentTarget.value as Export3DFormat)}>
                    {Object.entries(FORMATS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="fm-export-3d-dialog__field">
                  <span className="fm-export-3d-dialog__label">File name</span>
                  <input className="fm-export-3d-dialog__input" value={filename} disabled={exporting}
                    onChange={(event) => setFilename(event.currentTarget.value)} />
                </label>
              </div>
              <div className="fm-export-3d-dialog__checkbox-grid">
                <label className="fm-export-3d-dialog__checkbox-row">
                  <input className="fm-export-3d-dialog__checkbox" type="checkbox"
                    checked={hasVectors && includeVectors} disabled={exporting || !hasVectors}
                    onChange={(event) => setIncludeVectors(event.currentTarget.checked)} />
                  {vtk ? "Include vector field data" : "Include vector arrows"}
                </label>
                <label className="fm-export-3d-dialog__checkbox-row">
                  <input className="fm-export-3d-dialog__checkbox" type="checkbox"
                    checked={hasAirbox && includeAirbox} disabled={exporting || !hasAirbox}
                    onChange={(event) => setIncludeAirbox(event.currentTarget.checked)} />
                  Include Airbox
                </label>
                {canAnimate ? (
                  <label className="fm-export-3d-dialog__checkbox-row">
                    <input className="fm-export-3d-dialog__checkbox" type="checkbox"
                      checked={animate} disabled={exporting}
                      onChange={(event) => setAnimate(event.currentTarget.checked)} />
                    Animate mode phase
                  </label>
                ) : null}
              </div>
              {targets.length === 0 ? (
                <p role="status">No exportable geometry is selected.</p>
              ) : null}
              {!hasAirbox ? (
                <p className="fm-export-3d-dialog__hint">Airbox geometry is unavailable.</p>
              ) : includeAirbox && includeVectors && !targets.some((target) =>
                target.role === "airbox" && target.field?.componentCount === 3,
              ) ? (
                <p className="fm-export-3d-dialog__hint">Airbox vector data is unavailable.</p>
              ) : null}
              {source.warnings.length ? (
                <ul className="fm-export-3d-dialog__warnings">
                  {source.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
            </>
          ) : null}
          {!source && !sourceError ? <p role="status">Preparing the current 3D view…</p> : null}
          {sourceError || error ? <p role="alert" className="fm-export-3d-dialog__error">{sourceError ?? error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => viewport3dStore.setExport3DDialogOpen(false)}>
            {exporting ? "Cancel" : "Close"}
          </Button>
          <Button variant="primary" disabled={exporting || targets.length === 0} onClick={() => void onExport()}>
            {exporting ? "Exporting…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
