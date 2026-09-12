import * as THREE from "three";

export const COMP_NEGATIVE = new THREE.Color("#2f6caa");
export const COMP_NEUTRAL  = new THREE.Color("#f4f1ed");
export const COMP_POSITIVE = new THREE.Color("#cf6256");

export const QUALITY_GOOD   = new THREE.Color("#35b779");
export const QUALITY_MID    = new THREE.Color("#fde725");
export const QUALITY_BAD    = new THREE.Color("#cf6256");
const MAG_STOPS = [
  new THREE.Color(0x440154),
  new THREE.Color(0x31688e),
  new THREE.Color(0x35b779),
  new THREE.Color(0xfde725),
] as const;

export function divergingColor(value: number, color: THREE.Color): void {
  const v = THREE.MathUtils.clamp(value, -1, 1);
  if (v < 0) color.copy(COMP_NEUTRAL).lerp(COMP_NEGATIVE, Math.abs(v));
  else       color.copy(COMP_NEUTRAL).lerp(COMP_POSITIVE, v);
}

export function magnitudeColor(mag: number, color: THREE.Color): void {
  const t = THREE.MathUtils.clamp(mag, 0, 1);
  const idx = Math.min(Math.floor(t * 3), 2);
  const frac = t * 3 - idx;
  color.copy(MAG_STOPS[idx]).lerp(MAG_STOPS[idx + 1], frac);
}

export function qualityColor(ar: number, color: THREE.Color): void {
  // AR=1 is perfect, >5 is bad
  const t = THREE.MathUtils.clamp((ar - 1) / 9, 0, 1); // 1→0, 10→1
  if (t < 0.5) color.copy(QUALITY_GOOD).lerp(QUALITY_MID, t * 2);
  else         color.copy(QUALITY_MID).lerp(QUALITY_BAD, (t - 0.5) * 2);
}

export function sicnQualityColor(sicn: number, color: THREE.Color): void {
  // SICN: 1 = perfect, 0 = degenerate, <0 = inverted
  const t = THREE.MathUtils.clamp(sicn, -1, 1);
  if (t < 0) {
    color.copy(QUALITY_BAD);
  } else if (t < 0.3) {
    color.copy(QUALITY_BAD).lerp(QUALITY_MID, t / 0.3);
  } else {
    color.copy(QUALITY_MID).lerp(QUALITY_GOOD, (t - 0.3) / 0.7);
  }
}

export function computeFaceAspectRatios(nodes: ArrayLike<number>, faces: ArrayLike<number>): Float32Array {
  const nFaces = faces.length / 3;
  const ars = new Float32Array(nFaces);
  for (let f = 0; f < nFaces; f++) {
    const ia = faces[f * 3], ib = faces[f * 3 + 1], ic = faces[f * 3 + 2];
    const ax = nodes[ia * 3], ay = nodes[ia * 3 + 1], az = nodes[ia * 3 + 2];
    const bx = nodes[ib * 3], by = nodes[ib * 3 + 1], bz = nodes[ib * 3 + 2];
    const cx = nodes[ic * 3], cy = nodes[ic * 3 + 1], cz = nodes[ic * 3 + 2];
    const ab = Math.sqrt((bx-ax)**2 + (by-ay)**2 + (bz-az)**2);
    const bc = Math.sqrt((cx-bx)**2 + (cy-by)**2 + (cz-bz)**2);
    const ca = Math.sqrt((ax-cx)**2 + (ay-cy)**2 + (az-cz)**2);
    const maxEdge = Math.max(ab, bc, ca);
    const sp = (ab + bc + ca) / 2;
    const area = Math.sqrt(Math.max(0, sp * (sp - ab) * (sp - bc) * (sp - ca)));
    // Circumradius-to-inradius ratio (normalized): AR = (maxEdge * sp) / (4 * area)
    const inradius = area > 0 ? area / sp : 0;
    ars[f] = inradius > 1e-18 ? maxEdge / (2 * inradius) : 1;
  }
  return ars;
}
