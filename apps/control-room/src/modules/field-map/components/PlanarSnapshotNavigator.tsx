"use client";

import { useEffect, useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { useHysteresisPointsResource } from "@/kernel/resources/studyRuntimeResources";
import { hysteresisPointSelectionPayload } from "@/kernel/runtime/studyRuntimeCommandContributions";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { Button } from "@/shared/ui/Button";

import type { PlanarEvidenceStatus } from "../model/fieldMapEvidence";
import { adjacentSnapshot, snapshotIndex, snapshotSequence } from "../model/planarSnapshotNavigation";

/** Pause on each frame of the replay once it is drawn. */
const PLAYBACK_DWELL_MS = 600;

/**
 * Stage/snapshot navigator above the 2D map (F6 B4). Steps through the `m`
 * snapshots of the selected hysteresis stage with the same selection the
 * hysteresis chart publishes, so the planar query carries `stage_id` and
 * `snapshot_id`; Live clears it. Playback advances only after the current
 * frame is drawn (`status` ready), so it never outruns the sampler.
 */
export function PlanarSnapshotNavigator({ status }: { status: PlanarEvidenceStatus }) {
  const kernel = useKernel();
  const selected = useSelectionSelector((selection) => {
    const ref = selection.ref as { snapshotId?: unknown; stageId?: unknown } | null | undefined;
    return {
      snapshotId: typeof ref?.snapshotId === "string" ? ref.snapshotId : null,
      stageId: typeof ref?.stageId === "string" ? ref.stageId : null,
    };
  }, { isEqual: (left, right) => left.snapshotId === right.snapshotId && left.stageId === right.stageId });
  const points = useHysteresisPointsResource(selected.stageId, { enabled: selected.stageId !== null });
  const sequence = useMemo(() => snapshotSequence(points.data?.points), [points.data?.points]);
  const index = snapshotIndex(sequence, selected.snapshotId);
  const current = index >= 0 ? sequence[index]! : null;
  const [playing, setPlaying] = useState(false);

  const show = (step: -1 | 1) => {
    const next = adjacentSnapshot(sequence, selected.snapshotId, step);
    if (!next || !selected.stageId) return false;
    kernel.selection.set(hysteresisPointSelectionPayload({ point: next, stageId: selected.stageId }), "field-map");
    return true;
  };

  useEffect(() => {
    if (!playing || status !== "ready") return;
    const timer = window.setTimeout(() => {
      const next = adjacentSnapshot(sequence, selected.snapshotId, 1);
      if (!next || !selected.stageId) {
        setPlaying(false);
        return;
      }
      kernel.selection.set(hysteresisPointSelectionPayload({ point: next, stageId: selected.stageId }), "field-map");
    }, PLAYBACK_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [kernel, playing, selected.snapshotId, selected.stageId, sequence, status]);

  if (!selected.stageId || sequence.length === 0) return null;
  return (
    <div
      aria-label="Snapshot navigator"
      className="fm-field-map__snapshot-nav"
      data-snapshot-count={sequence.length}
      data-snapshot-id={selected.snapshotId ?? ""}
      data-snapshot-index={index}
      role="toolbar"
    >
      <span className="fm-field-map__control-label">Stage {selected.stageId}</span>
      <Button aria-label="Previous snapshot" disabled={index === 0} size="sm" type="button" variant="ghost" onClick={() => show(-1)}>
        ‹
      </Button>
      <span className="fm-field-map__snapshot-readout" aria-live="polite">
        {current
          ? `Snapshot ${index + 1} / ${sequence.length} · B = ${current.field_value_mT} mT${current.branch_id ? ` · ${current.branch_id}` : ""}`
          : `Live · ${sequence.length} snapshots`}
      </span>
      <Button aria-label="Next snapshot" disabled={index === sequence.length - 1} size="sm" type="button" variant="ghost" onClick={() => show(1)}>
        ›
      </Button>
      <Button
        aria-pressed={playing}
        size="sm"
        type="button"
        variant={playing ? "primary" : "ghost"}
        onClick={() => setPlaying((value) => !value)}
      >
        {playing ? "Pause" : "Play"}
      </Button>
      <Button
        disabled={current === null}
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => {
          setPlaying(false);
          kernel.selection.clear("field-map");
        }}
      >
        Live
      </Button>
    </div>
  );
}
