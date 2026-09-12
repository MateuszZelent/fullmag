/**
 * Unified node-mask helpers.
 *
 * The canonical runtime type for node masks is `Uint8Array` with values `0/1`.
 * These helpers handle both `Uint8Array` and legacy `boolean[]` transparently.
 */

export type NodeMask = Uint8Array;

/**
 * Returns `true` when the node at `nodeIndex` is active in the given mask.
 * Works for both `Uint8Array` (0/1) and `boolean[]`.
 */
export function isNodeActive(
  mask: ArrayLike<number | boolean> | null | undefined,
  nodeIndex: number,
): boolean {
  return Boolean(mask?.[nodeIndex]);
}

/**
 * Count the number of active (truthy) entries in a mask.
 */
export function countActiveNodes(
  mask: ArrayLike<number | boolean> | null | undefined,
): number {
  if (!mask || mask.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      count += 1;
    }
  }
  return count;
}

/**
 * Normalize any mask-like input to `Uint8Array`.
 * Returns `null` when input is null/undefined.
 */
export function normalizeNodeMask(
  mask: ArrayLike<number | boolean> | null | undefined,
  expectedLength?: number,
): NodeMask | null {
  if (!mask) {
    return null;
  }
  if (expectedLength != null && mask.length !== expectedLength) {
    return null;
  }
  if (mask instanceof Uint8Array) {
    return mask;
  }
  const result = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    result[i] = mask[i] ? 1 : 0;
  }
  return result;
}

/**
 * Union (logical OR) of two masks. Result is `1` if either input is truthy.
 */
export function unionNodeMasks(a: NodeMask, b: NodeMask): NodeMask {
  const len = Math.max(a.length, b.length);
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    result[i] = (a[i] || b[i]) ? 1 : 0;
  }
  return result;
}

/**
 * Intersection (logical AND) of two masks. Result is `1` only when both inputs are truthy.
 */
export function intersectNodeMasks(a: NodeMask, b: NodeMask): NodeMask {
  const len = Math.min(a.length, b.length);
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    result[i] = (a[i] && b[i]) ? 1 : 0;
  }
  return result;
}

/**
 * Describe the runtime kind of a mask for diagnostics.
 */
export function maskKind(
  mask: ArrayLike<number | boolean> | null | undefined,
): "uint8" | "boolean" | "none" {
  if (!mask) return "none";
  if (mask instanceof Uint8Array) return "uint8";
  return "boolean";
}
