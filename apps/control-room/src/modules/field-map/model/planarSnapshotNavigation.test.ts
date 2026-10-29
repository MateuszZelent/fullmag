import { describe, expect, it } from "vitest";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";

import { adjacentSnapshot, snapshotIndex, snapshotSequence } from "./planarSnapshotNavigation";

const point = (point_id: number, snapshot_id: string | null) =>
  ({ field_value_mT: point_id * 10, point_id, snapshot_id }) as HysteresisPointSchema;

describe("planar snapshot navigation", () => {
  const sequence = snapshotSequence([point(3, "s3"), point(1, "s1"), point(2, null), point(4, "s4")]);

  it("keeps only points with a snapshot, in point order", () => {
    expect(sequence.map((item) => item.snapshot_id)).toEqual(["s1", "s3", "s4"]);
    expect(snapshotIndex(sequence, "s3")).toBe(1);
    expect(snapshotIndex(sequence, null)).toBe(-1);
  });

  it("steps to neighbours and stops at the ends", () => {
    expect(adjacentSnapshot(sequence, "s3", 1)?.snapshot_id).toBe("s4");
    expect(adjacentSnapshot(sequence, "s3", -1)?.snapshot_id).toBe("s1");
    expect(adjacentSnapshot(sequence, "s4", 1)).toBeNull();
    expect(adjacentSnapshot(sequence, "s1", -1)).toBeNull();
  });

  it("enters the sequence at its first or last snapshot from live", () => {
    expect(adjacentSnapshot(sequence, null, 1)?.snapshot_id).toBe("s1");
    expect(adjacentSnapshot(sequence, null, -1)?.snapshot_id).toBe("s4");
    expect(adjacentSnapshot([], null, 1)).toBeNull();
  });
});
