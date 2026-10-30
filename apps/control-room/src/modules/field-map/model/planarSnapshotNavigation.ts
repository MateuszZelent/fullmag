import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";

/** Hysteresis points that published an `m` snapshot, in point order. */
export function snapshotSequence(
  points: readonly HysteresisPointSchema[] | null | undefined,
): HysteresisPointSchema[] {
  return (points ?? [])
    .filter((point) => typeof point.snapshot_id === "string" && point.snapshot_id.length > 0)
    .sort((left, right) => left.point_id - right.point_id);
}

/** Index of the shown snapshot in the sequence, or -1 when it is not part of it. */
export function snapshotIndex(
  sequence: readonly HysteresisPointSchema[],
  snapshotId: string | null,
): number {
  return snapshotId === null ? -1 : sequence.findIndex((point) => point.snapshot_id === snapshotId);
}

/** Neighbour `step` positions away, clamped to the sequence; null at the ends. */
export function adjacentSnapshot(
  sequence: readonly HysteresisPointSchema[],
  snapshotId: string | null,
  step: -1 | 1,
): HysteresisPointSchema | null {
  const index = snapshotIndex(sequence, snapshotId);
  if (index < 0) return sequence.length > 0 ? sequence[step > 0 ? 0 : sequence.length - 1]! : null;
  return sequence[index + step] ?? null;
}
