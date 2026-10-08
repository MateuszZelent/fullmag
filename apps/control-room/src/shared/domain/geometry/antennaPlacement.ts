export type PlacementVector = readonly [number, number, number];

export interface PlacementWorldBounds {
  readonly min: PlacementVector;
  readonly max: PlacementVector;
}

export interface AntennaPlacement {
  readonly delta: PlacementVector;
  readonly translation: PlacementVector;
}

function validateVector(value: PlacementVector, label: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    throw new Error(`${label} requires three finite SI components.`);
  }
}

function validateBounds(bounds: PlacementWorldBounds, label: string): void {
  validateVector(bounds.min, `${label} min`);
  validateVector(bounds.max, `${label} max`);
  if (bounds.min.some((value, axis) => value >= bounds.max[axis])) {
    throw new Error(`${label} requires strictly ordered world bounds.`);
  }
}

/** Translate the whole assembly along world Z; callers own canonical bounds provenance and revision guards. */
export function calculateAntennaPlacement(
  antenna: PlacementWorldBounds,
  target: PlacementWorldBounds,
  currentTranslation: PlacementVector,
  side: "above" | "below",
  gapM: number,
): AntennaPlacement {
  validateBounds(antenna, "Antenna");
  validateBounds(target, "Target");
  validateVector(currentTranslation, "Current translation");
  if (side !== "above" && side !== "below") throw new Error("Placement side must be above or below.");
  if (typeof gapM !== "number" || !Number.isFinite(gapM) || gapM <= 0) throw new Error("Placement gap must be a finite positive SI length.");

  const targetFace = side === "above" ? target.max[2] : target.min[2];
  const antennaFace = side === "above" ? antenna.min[2] : antenna.max[2];
  const desiredFace = side === "above" ? targetFace + gapM : targetFace - gapM;
  const requestedDelta = desiredFace - antennaFace;
  const nextZ = currentTranslation[2] + requestedDelta;
  const actualDelta = nextZ - currentTranslation[2];
  const movedMin = antenna.min[2] + actualDelta;
  const movedMax = antenna.max[2] + actualDelta;
  const actualGap = side === "above" ? movedMin - targetFace : targetFace - movedMax;
  // Gap-relative tolerance never grows with absolute world coordinates and cannot conceal a lost small gap.
  const gapTolerance = gapM * 1e-9;
  if (![desiredFace, requestedDelta, nextZ, actualDelta, movedMin, movedMax, actualGap].every(Number.isFinite)
    || movedMin >= movedMax || actualGap <= 0 || Math.abs(actualGap - gapM) > gapTolerance) {
    throw new Error("Requested placement gap is not representable at these world coordinates and translation.");
  }
  return { delta: [0, 0, actualDelta], translation: [currentTranslation[0], currentTranslation[1], nextZ] };
}
