/**
 * Allocation-free keys for mesh faces and edges in topology index builds.
 *
 * A million-cell mesh has millions of faces and edges. Keying them by a
 * sorted-node string allocated a string (and a sorted copy) per face per
 * pass, which dominated the topology index build at tens of seconds. Faces
 * are interned here in an open-addressing table over typed arrays, and edges
 * use an exact numeric key whenever the node count allows it.
 */

/** Sorts after every real node index, so a triangle is a quad with a hole. */
const MISSING_NODE = 0xffffffff;

/**
 * Interns faces of three or four nodes, ignoring node order, to dense ids in
 * first-seen order (the same order a Map keyed by the sorted nodes yields).
 */
export class FaceKeyTable {
  /** Number of distinct faces interned so far. */
  size = 0;
  private keys: Uint32Array;
  private slotIds: Int32Array;
  private mask: number;
  private readonly sorted = new Uint32Array(4);

  constructor(expectedFaces = 1024) {
    let capacity = 1024;
    while (capacity < expectedFaces * 2) capacity *= 2;
    this.keys = new Uint32Array(capacity * 4);
    this.slotIds = new Int32Array(capacity).fill(-1);
    this.mask = capacity - 1;
  }

  /** Whether the last `intern` call created its face. */
  created = false;

  /** Id of the face, creating it when unseen (see `created`). */
  intern(n0: number, n1: number, n2: number, n3: number = MISSING_NODE): number {
    this.sort(n0, n1, n2, n3);
    const found = this.lookup();
    this.created = found < 0;
    if (found >= 0) return found;
    if ((this.size + 1) * 2 > this.slotIds.length) this.grow();
    const id = this.size;
    this.size += 1;
    this.store(this.emptySlot(), id);
    return id;
  }

  /** Id of an interned face, or -1; faces outside three or four nodes are never interned. */
  find(nodes: readonly number[]): number {
    if (nodes.length !== 3 && nodes.length !== 4) return -1;
    this.sort(nodes[0] ?? 0, nodes[1] ?? 0, nodes[2] ?? 0, nodes[3] ?? MISSING_NODE);
    return this.lookup();
  }

  private sort(n0: number, n1: number, n2: number, n3: number): void {
    let a = n0 >>> 0;
    let b = n1 >>> 0;
    let c = n2 >>> 0;
    let d = n3 >>> 0;
    let swap: number;
    if (a > b) { swap = a; a = b; b = swap; }
    if (c > d) { swap = c; c = d; d = swap; }
    if (a > c) { swap = a; a = c; c = swap; }
    if (b > d) { swap = b; b = d; d = swap; }
    if (b > c) { swap = b; b = c; c = swap; }
    this.sorted[0] = a;
    this.sorted[1] = b;
    this.sorted[2] = c;
    this.sorted[3] = d;
  }

  private hash(): number {
    const s = this.sorted;
    let h = Math.imul((s[0] ?? 0) ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (s[1] ?? 0), 0xc2b2ae35);
    h = Math.imul(h ^ (s[2] ?? 0), 0x27d4eb2f);
    h = Math.imul(h ^ (s[3] ?? 0), 0x165667b1);
    return (h ^ (h >>> 15)) & this.mask;
  }

  private lookup(): number {
    const s = this.sorted;
    for (let slot = this.hash(); ; slot = (slot + 1) & this.mask) {
      const id = this.slotIds[slot] ?? -1;
      if (id < 0) return -1;
      const base = slot * 4;
      if (
        this.keys[base] === s[0] &&
        this.keys[base + 1] === s[1] &&
        this.keys[base + 2] === s[2] &&
        this.keys[base + 3] === s[3]
      ) {
        return id;
      }
    }
  }

  private emptySlot(): number {
    let slot = this.hash();
    while ((this.slotIds[slot] ?? -1) >= 0) slot = (slot + 1) & this.mask;
    return slot;
  }

  private store(slot: number, id: number): void {
    this.keys.set(this.sorted, slot * 4);
    this.slotIds[slot] = id;
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldIds = this.slotIds;
    // Rehashing reuses the sort buffer; keep the face being inserted.
    const pending = this.sorted.slice();
    const capacity = oldIds.length * 2;
    this.keys = new Uint32Array(capacity * 4);
    this.slotIds = new Int32Array(capacity).fill(-1);
    this.mask = capacity - 1;
    for (let slot = 0; slot < oldIds.length; slot += 1) {
      const id = oldIds[slot] ?? -1;
      if (id < 0) continue;
      this.sorted.set(oldKeys.subarray(slot * 4, slot * 4 + 4));
      this.store(this.emptySlot(), id);
    }
    this.sorted.set(pending);
  }
}

/** Undirected edges keyed exactly; numeric when the node bound allows it. */
export class EdgeKeySet {
  private readonly numeric: Set<number> | null;
  private readonly text: Set<string> | null;

  constructor(private readonly nodeBound: number) {
    const numeric = nodeBound > 0 && nodeBound * nodeBound <= Number.MAX_SAFE_INTEGER;
    this.numeric = numeric ? new Set<number>() : null;
    this.text = numeric ? null : new Set<string>();
  }

  /** Adds the edge between two distinct nodes given low-high; true when new. */
  add(low: number, high: number): boolean {
    if (this.numeric) {
      const key = low * this.nodeBound + high;
      if (this.numeric.has(key)) return false;
      this.numeric.add(key);
      return true;
    }
    const key = `${low}:${high}`;
    if (this.text?.has(key)) return false;
    this.text?.add(key);
    return true;
  }
}

/** One past the largest index, the exact bound for numeric edge keys. */
export function indexBound(indices: ArrayLike<number>): number {
  let max = -1;
  for (let index = 0; index < indices.length; index += 1) {
    const value = indices[index] ?? 0;
    if (value > max) max = value;
  }
  return max + 1;
}
