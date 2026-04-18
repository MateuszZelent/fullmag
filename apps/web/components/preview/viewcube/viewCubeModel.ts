import { sceneAxisDescriptor, type AxisConvention } from "../transform/axisConvention";
import type { Direction3 } from "../camera/cameraOrientation";

export type ViewTargetKind = "face" | "edge" | "corner";

export interface ViewTarget {
  id: string;
  direction: Direction3;
  kind: ViewTargetKind;
  label?: string;
  previewLabel: string;
  ariaLabel: string;
  adjacentFaceIds: readonly string[];
}

export interface ViewCubeFaceModel {
  id: "top" | "bottom" | "right" | "left" | "front" | "back";
  transform: string;
  targets: readonly ViewTarget[];
}

const CUBE = 62;
const HALF = CUBE / 2;

const FACE_TRANSFORMS = {
  top: `rotateX(90deg)  translateZ(${HALF}px)`,
  bottom: `rotateX(-90deg) translateZ(${HALF}px)`,
  right: `rotateY(90deg)  translateZ(${HALF}px)`,
  left: `rotateY(-90deg) translateZ(${HALF}px)`,
  front: `translateZ(${HALF}px)`,
  back: `rotateY(180deg) translateZ(${HALF}px)`,
} as const;

const FACE_NAME_BY_AXIS = {
  x: ["left", "right"],
  y: ["bottom", "top"],
  z: ["back", "front"],
} as const;

function add3(a: Direction3, b: Direction3, c?: Direction3): Direction3 {
  return [a[0] + b[0] + (c?.[0] ?? 0), a[1] + b[1] + (c?.[1] ?? 0), a[2] + b[2] + (c?.[2] ?? 0)];
}

function neg3(a: Direction3): Direction3 {
  return [-a[0], -a[1], -a[2]];
}

function directionTokens(direction: Direction3): string[] {
  const tokens: string[] = [];
  if (direction[0] !== 0) {
    tokens.push(direction[0] > 0 ? "right" : "left");
  }
  if (direction[1] !== 0) {
    tokens.push(direction[1] > 0 ? "top" : "bottom");
  }
  if (direction[2] !== 0) {
    tokens.push(direction[2] > 0 ? "front" : "back");
  }
  return tokens;
}

function formatDirectionLabel(direction: Direction3, axisConvention: AxisConvention): string {
  const parts: string[] = [];
  if (direction[0] !== 0) {
    const descriptor = sceneAxisDescriptor(0, axisConvention);
    parts.push(`${direction[0] > 0 ? "+" : "-"}${descriptor.text}`);
  }
  if (direction[1] !== 0) {
    const descriptor = sceneAxisDescriptor(1, axisConvention);
    parts.push(`${direction[1] > 0 ? "+" : "-"}${descriptor.text}`);
  }
  if (direction[2] !== 0) {
    const descriptor = sceneAxisDescriptor(2, axisConvention);
    parts.push(`${direction[2] > 0 ? "+" : "-"}${descriptor.text}`);
  }
  return parts.join(" ");
}

function directionFaceIds(direction: Direction3): string[] {
  const faces: string[] = [];
  if (direction[0] !== 0) {
    faces.push(FACE_NAME_BY_AXIS.x[direction[0] > 0 ? 1 : 0]);
  }
  if (direction[1] !== 0) {
    faces.push(FACE_NAME_BY_AXIS.y[direction[1] > 0 ? 1 : 0]);
  }
  if (direction[2] !== 0) {
    faces.push(FACE_NAME_BY_AXIS.z[direction[2] > 0 ? 1 : 0]);
  }
  return faces;
}

function createTarget(
  direction: Direction3,
  kind: ViewTargetKind,
  axisConvention: AxisConvention,
  label?: string,
): ViewTarget {
  const title = formatDirectionLabel(direction, axisConvention);
  return {
    id: directionTokens(direction).join("-"),
    direction,
    kind,
    label,
    previewLabel: `View ${title}`,
    ariaLabel: `Set camera to ${title} view`,
    adjacentFaceIds: directionFaceIds(direction),
  };
}

function buildFaceTargets(
  normal: Direction3,
  up: Direction3,
  right: Direction3,
  axisConvention: AxisConvention,
  faceLabel: string,
): readonly ViewTarget[] {
  return [
    createTarget(add3(normal, up, neg3(right)), "corner", axisConvention),
    createTarget(add3(normal, up), "edge", axisConvention),
    createTarget(add3(normal, up, right), "corner", axisConvention),
    createTarget(add3(normal, neg3(right)), "edge", axisConvention),
    createTarget(normal, "face", axisConvention, faceLabel),
    createTarget(add3(normal, right), "edge", axisConvention),
    createTarget(add3(normal, neg3(up), neg3(right)), "corner", axisConvention),
    createTarget(add3(normal, neg3(up)), "edge", axisConvention),
    createTarget(add3(normal, neg3(up), right), "corner", axisConvention),
  ];
}

export function buildViewCubeFaces(axisConvention: AxisConvention): readonly ViewCubeFaceModel[] {
  const axisX = sceneAxisDescriptor(0, axisConvention);
  const axisY = sceneAxisDescriptor(1, axisConvention);
  const axisZ = sceneAxisDescriptor(2, axisConvention);

  return [
    {
      id: "top",
      transform: FACE_TRANSFORMS.top,
      targets: buildFaceTargets([0, 1, 0], [0, 0, 1], [1, 0, 0], axisConvention, axisY.text),
    },
    {
      id: "bottom",
      transform: FACE_TRANSFORMS.bottom,
      targets: buildFaceTargets([0, -1, 0], [0, 0, 1], [-1, 0, 0], axisConvention, `-${axisY.text}`),
    },
    {
      id: "right",
      transform: FACE_TRANSFORMS.right,
      targets: buildFaceTargets([1, 0, 0], [0, 1, 0], [0, 0, -1], axisConvention, axisX.text),
    },
    {
      id: "left",
      transform: FACE_TRANSFORMS.left,
      targets: buildFaceTargets([-1, 0, 0], [0, 1, 0], [0, 0, 1], axisConvention, `-${axisX.text}`),
    },
    {
      id: "front",
      transform: FACE_TRANSFORMS.front,
      targets: buildFaceTargets([0, 0, 1], [0, 1, 0], [1, 0, 0], axisConvention, axisZ.text),
    },
    {
      id: "back",
      transform: FACE_TRANSFORMS.back,
      targets: buildFaceTargets([0, 0, -1], [0, 1, 0], [-1, 0, 0], axisConvention, `-${axisZ.text}`),
    },
  ];
}

export function buildViewCubeTargetMap(faces: readonly ViewCubeFaceModel[]): Map<string, ViewTarget> {
  const map = new Map<string, ViewTarget>();
  for (const face of faces) {
    for (const target of face.targets) {
      map.set(target.id, target);
    }
  }
  return map;
}
