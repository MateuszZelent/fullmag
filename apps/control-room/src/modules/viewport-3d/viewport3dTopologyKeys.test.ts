import { describe, expect, it } from "vitest";

import { EdgeKeySet, FaceKeyTable, indexBound } from "./viewport3dTopologyKeys";

describe("FaceKeyTable", () => {
  it("interns faces independent of node order in first-seen order", () => {
    const faces = new FaceKeyTable(4);
    expect(faces.intern(5, 1, 3)).toBe(0);
    expect(faces.created).toBe(true);
    expect(faces.intern(3, 5, 1)).toBe(0);
    expect(faces.created).toBe(false);
    expect(faces.intern(1, 3, 5, 7)).toBe(1);
    expect(faces.created).toBe(true);
    expect(faces.intern(7, 5, 3, 1)).toBe(1);
    expect(faces.find([1, 5, 3])).toBe(0);
    expect(faces.find([5, 7, 1, 3])).toBe(1);
    expect(faces.find([1, 3, 7])).toBe(-1);
    expect(faces.find([1, 3])).toBe(-1);
  });

  it("keeps ids stable while growing past its initial capacity", () => {
    const faces = new FaceKeyTable(1);
    for (let index = 0; index < 5_000; index += 1) {
      expect(faces.intern(index, index + 1, index + 2)).toBe(index);
    }
    expect(faces.size).toBe(5_000);
    for (let index = 0; index < 5_000; index += 1) {
      expect(faces.find([index + 2, index, index + 1])).toBe(index);
    }
  });
});

describe("EdgeKeySet", () => {
  it("reports each undirected edge once with numeric or text keys", () => {
    for (const bound of [10, 2 ** 30]) {
      const edges = new EdgeKeySet(bound);
      expect(edges.add(1, 2)).toBe(true);
      expect(edges.add(1, 2)).toBe(false);
      expect(edges.add(2, 3)).toBe(true);
    }
    expect(indexBound([3, 9, 4])).toBe(10);
    expect(indexBound([])).toBe(0);
  });
});
