export type ViewCubeTargetKind = "face" | "edge" | "corner";

export interface ViewCubeAxisLabels {
  x: string;
  y: string;
  z: string;
}

export interface ViewCubeTarget {
  direction: [number, number, number];
  id: string;
  kind?: ViewCubeTargetKind;
  label?: string;
}

export interface ViewCubeFaceModel {
  id: "top" | "bottom" | "right" | "left" | "front" | "back";
  normal: [number, number, number];
  right: [number, number, number];
  targets: readonly ViewCubeTarget[];
  up: [number, number, number];
}

export interface ViewCubeTargetCell {
  col: number;
  height: number;
  row: number;
  width: number;
  x: number;
  y: number;
}

const AXIS_STEPS = [-1, 0, 1] as const;

export function getViewCubeAxisLabels(): ViewCubeAxisLabels {
  return {
    x: "+X",
    y: "+Y",
    z: "+Z",
  };
}

export function buildViewCubeTargetMap(): Map<string, ViewCubeTarget> {
  const targets = new Map<string, ViewCubeTarget>();

  for (const x of AXIS_STEPS) {
    for (const y of AXIS_STEPS) {
      for (const z of AXIS_STEPS) {
        if (x === 0 && y === 0 && z === 0) {
          continue;
        }

        const id = viewCubeTargetId(x, y, z);
        targets.set(id, {
          direction: [x, y, z],
          id,
        });
      }
    }
  }

  return targets;
}

export function buildViewCubeFaces(): readonly ViewCubeFaceModel[] {
  const axisLabels = getViewCubeAxisLabels();

  return [
    {
      id: "top",
      normal: [0, 1, 0],
      right: [1, 0, 0],
      targets: buildFaceTargets(
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0],
        trimPositive(axisLabels.y),
      ),
      up: [0, 0, 1],
    },
    {
      id: "bottom",
      normal: [0, -1, 0],
      right: [-1, 0, 0],
      targets: buildFaceTargets(
        [0, -1, 0],
        [0, 0, 1],
        [-1, 0, 0],
        axisLabels.y.replace("+", "-"),
      ),
      up: [0, 0, 1],
    },
    {
      id: "right",
      normal: [1, 0, 0],
      right: [0, 0, -1],
      targets: buildFaceTargets(
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, -1],
        trimPositive(axisLabels.x),
      ),
      up: [0, 1, 0],
    },
    {
      id: "left",
      normal: [-1, 0, 0],
      right: [0, 0, 1],
      targets: buildFaceTargets(
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        axisLabels.x.replace("+", "-"),
      ),
      up: [0, 1, 0],
    },
    {
      id: "front",
      normal: [0, 0, 1],
      right: [1, 0, 0],
      targets: buildFaceTargets(
        [0, 0, 1],
        [0, 1, 0],
        [1, 0, 0],
        trimPositive(axisLabels.z),
      ),
      up: [0, 1, 0],
    },
    {
      id: "back",
      normal: [0, 0, -1],
      right: [-1, 0, 0],
      targets: buildFaceTargets(
        [0, 0, -1],
        [0, 1, 0],
        [-1, 0, 0],
        axisLabels.z.replace("+", "-"),
      ),
      up: [0, 1, 0],
    },
  ];
}

export function resolveViewCubeTargetCell(
  index: number,
  faceSize: number,
  edgeSize: number,
): ViewCubeTargetCell {
  if (!Number.isInteger(index) || index < 0 || index > 8) {
    throw new RangeError(`ViewCube target cell index must be between 0 and 8, got ${index}`);
  }

  const row = Math.floor(index / 3);
  const col = index % 3;
  const innerSize = faceSize - edgeSize * 2;
  const width = col === 1 ? innerSize : edgeSize;
  const height = row === 1 ? innerSize : edgeSize;
  const x =
    col === 0
      ? -faceSize / 2 + edgeSize / 2
      : col === 2
        ? faceSize / 2 - edgeSize / 2
        : 0;
  const y =
    row === 0
      ? faceSize / 2 - edgeSize / 2
      : row === 2
        ? -faceSize / 2 + edgeSize / 2
        : 0;

  return { col, height, row, width, x, y };
}

function buildFaceTargets(
  normal: [number, number, number],
  up: [number, number, number],
  right: [number, number, number],
  faceLabel: string,
): readonly ViewCubeTarget[] {
  return [
    createTarget(add3(normal, up, neg3(right)), "corner"),
    createTarget(add3(normal, up), "edge"),
    createTarget(add3(normal, up, right), "corner"),
    createTarget(add3(normal, neg3(right)), "edge"),
    createTarget(normal, "face", faceLabel),
    createTarget(add3(normal, right), "edge"),
    createTarget(add3(normal, neg3(up), neg3(right)), "corner"),
    createTarget(add3(normal, neg3(up)), "edge"),
    createTarget(add3(normal, neg3(up), right), "corner"),
  ];
}

function createTarget(
  direction: [number, number, number],
  kind: ViewCubeTargetKind,
  label?: string,
): ViewCubeTarget {
  return {
    direction,
    id: viewCubeTargetId(direction[0], direction[1], direction[2]),
    kind,
    label,
  };
}

function add3(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  return [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
}

function neg3(a: [number, number, number]): [number, number, number] {
  return [-a[0], -a[1], -a[2]];
}

function trimPositive(label: string): string {
  return label.startsWith("+") ? label.slice(1) : label;
}

function viewCubeTargetId(x: number, y: number, z: number): string {
  return [
    x < 0 ? "left" : x > 0 ? "right" : null,
    y < 0 ? "bottom" : y > 0 ? "top" : null,
    z < 0 ? "back" : z > 0 ? "front" : null,
  ]
    .filter((part): part is string => part !== null)
    .join("-");
}
