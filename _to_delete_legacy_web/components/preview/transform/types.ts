/** Transform tool modes */
export type TransformTool = "select" | "move" | "rotate" | "scale";

/** Coordinate space for transform operations */
export type TransformSpace = "world" | "local";

/** Pivot point strategy */
export type TransformPivotMode = "object-center" | "bounds-center" | "custom";

/** Full object transform (in world space) */
export interface ObjectTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion [x, y, z, w]
  scale: [number, number, number];
}

/** Active drag session state */
export interface TransformSession {
  objectId: string;
  tool: TransformTool;
  baseline: ObjectTransform;
  preview: ObjectTransform | null; // accumulated delta during drag
}

/** Snap configuration */
export interface SnapConfig {
  enabled: boolean;
  moveIncrement: number;     // distance units
  rotateDegrees: number;     // degrees
  scaleIncrement: number;    // multiplier step (e.g. 0.1)
}

/** Default identity transform */
export const IDENTITY_TRANSFORM: ObjectTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** Default snap config */
export const DEFAULT_SNAP: SnapConfig = {
  enabled: false,
  moveIncrement: 1e-9,     // 1 nm
  rotateDegrees: 15,
  scaleIncrement: 0.1,
};
