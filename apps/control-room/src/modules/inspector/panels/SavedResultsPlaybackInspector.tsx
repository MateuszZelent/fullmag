"use client";

import { useEffect, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import type { SavedPlaybackResource } from "@/kernel/api/savedResultsPlayback";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import { useSavedResultsManifestResource } from "@/kernel/resources/savedResultsPlaybackResources";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { Slider } from "@/shared/ui/Slider";

export function clampPlaybackFrameIndex(frameIndex: number, frameCount: number): number {
  const lastFrame = Math.max(0, Math.floor(frameCount) - 1);
  return Math.min(lastFrame, Math.max(0, Math.floor(frameIndex)));
}

export function formatSavedPlaybackTimeNs(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "Unavailable";
  return `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(seconds * 1e9)} ns`;
}

function frameTime(manifest: SavedPlaybackResource | null, stageId: string | null, frameIndex: number): number | undefined {
  const stage = manifest?.stages.find((candidate) => candidate.stage_id === stageId);
  return stage?.times_s[frameIndex];
}

function colorLimitText(value: number | null): string {
  return value === null ? "" : String(value);
}

function ColorLimitControl({
  itemId,
  value,
  onCommit,
}: {
  readonly itemId: string;
  readonly value: number | null;
  readonly onCommit: (next: number | null) => void;
}) {
  const [draft, setDraft] = useState<{ readonly baseValue: number | null; readonly text: string } | null>(null);
  const inputValue = draft && Object.is(draft.baseValue, value) ? draft.text : colorLimitText(value);

  const commit = () => {
    const text = inputValue.trim();
    if (!text) {
      onCommit(null);
      setDraft(null);
      return;
    }
    const numericValue = Number(text);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      onCommit(numericValue);
      setDraft(null);
      return;
    }
    setDraft(null);
  };

  return (
    <div className="fm-saved-results-playback-inspector__group">
      <label className="fm-saved-results-playback-inspector__label" htmlFor={`fm-saved-results-color-limit-${itemId}`}>
        Symmetric color limit
      </label>
      <Input
        aria-describedby={`fm-saved-results-color-limit-help-${itemId}`}
        id={`fm-saved-results-color-limit-${itemId}`}
        inputMode="decimal"
        min="0"
        onBlur={commit}
        onChange={(event) => setDraft({ baseValue: value, text: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        placeholder="Auto per frame"
        step="any"
        type="number"
        value={inputValue}
      />
      <p className="fm-saved-results-playback-inspector__help" id={`fm-saved-results-color-limit-help-${itemId}`}>
        Positive magnitude; leave blank for automatic per-frame scaling.
      </p>
    </div>
  );
}

export function SavedResultsPlaybackInspector() {
  const kernel = useKernel();
  const selection = useSavedResultsPlaybackSelection();
  const manifestResource = useSavedResultsManifestResource(selection?.itemId ?? null);
  const manifest = manifestResource.data;
  const stages = manifest?.stages ?? [];
  const selectedStage = stages.find((stage) => stage.stage_id === selection?.stageId) ?? stages[0];
  const frameCount = selectedStage?.frame_count ?? 0;
  const frameIndex = selection ? clampPlaybackFrameIndex(selection.frameIndex, frameCount) : 0;
  const lastFrame = Math.max(0, frameCount - 1);
  const stageId = selectedStage?.stage_id ?? null;
  const hasFrames = Boolean(selectedStage && frameCount > 0);

  useEffect(() => {
    if (!selection || !selectedStage || !kernel.savedResultsPlayback) return;
    if (selection.stageId !== selectedStage.stage_id) {
      kernel.savedResultsPlayback.selectStage(selectedStage.stage_id);
      return;
    }
    if (selection.frameIndex !== frameIndex) {
      kernel.savedResultsPlayback.selectFrame(frameIndex);
    }
  }, [frameIndex, kernel.savedResultsPlayback, selectedStage, selection]);

  if (!selection) return null;

  const selectFrame = (next: number) => {
    kernel.savedResultsPlayback?.selectFrame(clampPlaybackFrameIndex(next, frameCount));
  };
  return (
    <section aria-label="Saved results playback Inspector" className="fm-saved-results-playback-inspector">
      <header className="fm-saved-results-playback-inspector__header">
        <h2 className="fm-saved-results-playback-inspector__title">Saved result playback</h2>
        <p className="fm-saved-results-playback-inspector__name" title={selection.name}>{selection.name}</p>
        <p className="fm-saved-results-playback-inspector__readonly" role="note">
          Read-only playback. No source project or active session is required.
        </p>
      </header>

      {manifestResource.status === "loading" && !manifest ? (
        <p className="fm-saved-results-playback-inspector__status" role="status">Reading the saved result manifest…</p>
      ) : manifestResource.status === "error" && !manifest ? (
        <p className="fm-saved-results-playback-inspector__error" role="alert">
          Could not read this saved result folder: {manifestResource.error?.message ?? "Unknown error."}
        </p>
      ) : manifest ? (
        <>
          <dl className="fm-saved-results-playback-inspector__metadata">
            <div className="fm-saved-results-playback-inspector__metadata-row">
              <dt>{manifest.fem_mesh ? "FEM mesh" : "Grid"}</dt>
              <dd>{manifest.fem_mesh ? `${manifest.fem_mesh.node_count} nodes · ${manifest.fem_mesh.cell_count} cells` : `${manifest.grid_cells_xyz?.join(" × ")} cells`}</dd>
            </div>
            <div className="fm-saved-results-playback-inspector__metadata-row">
              <dt>{manifest.fem_mesh ? "Field support" : "Cell size"}</dt>
              <dd>{manifest.fem_mesh ? "Canonical H1/P1 nodes · saved active support" : manifest.cell_size_m?.map((value) => `${value} m`).join(" × ")}</dd>
            </div>
            <div className="fm-saved-results-playback-inspector__metadata-row">
              <dt>{manifest.fem_mesh ? "Coordinates" : "Origin"}</dt>
              <dd>{manifest.fem_mesh ? "Saved mesh · metres" : manifest.origin_m?.map((value) => `${value} m`).join(", ")}</dd>
            </div>
          </dl>
          {manifest.source_note ? (
            <p className="fm-saved-results-playback-inspector__source-note" role="note">
              {manifest.source_note}
            </p>
          ) : null}
          {manifestResource.refreshError ? (
            <p className="fm-saved-results-playback-inspector__status" role="status">
              Showing the last loaded manifest. Refresh failed: {manifestResource.refreshError.message}
            </p>
          ) : null}

          {stages.length > 0 ? (
            <div className="fm-saved-results-playback-inspector__group">
              <label className="fm-saved-results-playback-inspector__label" htmlFor="fm-saved-results-stage">
                Stage
              </label>
              <Select
                value={selectedStage?.stage_id ?? ""}
                onValueChange={(next) => kernel.savedResultsPlayback?.selectStage(next)}
              >
                <SelectTrigger aria-label="Saved results stage" id="fm-saved-results-stage">
                  <SelectValue placeholder="Select a stage" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((stage) => (
                    <SelectItem key={stage.stage_id} value={stage.stage_id}>{stage.stage_id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="fm-saved-results-playback-inspector__status" role="status">This folder has no saved stages.</p>
          )}

          <section aria-label="Saved frame" className="fm-saved-results-playback-inspector__group">
            <div className="fm-saved-results-playback-inspector__frame-heading">
              <h3 className="fm-saved-results-playback-inspector__label">Frame</h3>
              <output className="fm-saved-results-playback-inspector__frame-value" htmlFor="fm-saved-results-frame">
                {hasFrames ? `${frameIndex + 1} / ${frameCount}` : "Unavailable"}
              </output>
            </div>
            <Slider
              aria-label="Saved frame index"
              disabled={!hasFrames}
              id="fm-saved-results-frame"
              max={lastFrame}
              min={0}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) selectFrame(next);
              }}
              step={1}
              value={[frameIndex]}
            />
            <p className="fm-saved-results-playback-inspector__time" aria-live="polite">
              Time: {formatSavedPlaybackTimeNs(frameTime(manifest, stageId, frameIndex))}
            </p>
            <div aria-label="Frame navigation" className="fm-saved-results-playback-inspector__navigation">
              <Button aria-label="First frame" className="fm-saved-results-playback-inspector__nav-button" disabled={!hasFrames || frameIndex === 0} onClick={() => selectFrame(0)} size="sm" type="button" variant="secondary">First</Button>
              <Button aria-label="Previous frame" className="fm-saved-results-playback-inspector__nav-button" disabled={!hasFrames || frameIndex === 0} onClick={() => selectFrame(frameIndex - 1)} size="sm" type="button" variant="secondary">Previous</Button>
              <Button aria-label="Next frame" className="fm-saved-results-playback-inspector__nav-button" disabled={!hasFrames || frameIndex >= lastFrame} onClick={() => selectFrame(frameIndex + 1)} size="sm" type="button" variant="secondary">Next</Button>
              <Button aria-label="Last frame" className="fm-saved-results-playback-inspector__nav-button" disabled={!hasFrames || frameIndex >= lastFrame} onClick={() => selectFrame(lastFrame)} size="sm" type="button" variant="secondary">Last</Button>
            </div>
            {!hasFrames ? (
              <p className="fm-saved-results-playback-inspector__status" role="status">No saved frames are available in this stage.</p>
            ) : null}
          </section>

          <div className="fm-saved-results-playback-inspector__group">
            <label className="fm-saved-results-playback-inspector__label" htmlFor="fm-saved-results-component">
              Magnetization component
            </label>
            <Select
              value={`m_${["x", "y", "z"][selection.component]}`}
              onValueChange={(value) => {
                const component = value === "m_x" ? 0 : value === "m_y" ? 1 : 2;
                kernel.savedResultsPlayback?.setComponent(component);
              }}
            >
              <SelectTrigger aria-label="Saved results magnetization component" id="fm-saved-results-component">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="m_x">m_x</SelectItem>
                <SelectItem value="m_y">m_y</SelectItem>
                <SelectItem value="m_z">m_z</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ColorLimitControl
            itemId={selection.itemId}
            key={selection.itemId}
            onCommit={(value) => kernel.savedResultsPlayback?.setColorLimit(value)}
            value={selection.colorLimit}
          />

          <Button
            className="fm-saved-results-playback-inspector__close"
            onClick={() => kernel.savedResultsPlayback?.close()}
            type="button"
            variant="secondary"
          >
            Close playback
          </Button>
        </>
      ) : null}
    </section>
  );
}
