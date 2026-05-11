export type ViewCubeSceneConvention = "identity" | "swapYZ";

export interface ViewCubeAxisLabels {
  x: string;
  y: string;
  z: string;
}

export interface ViewCubeTarget {
  direction: [number, number, number];
  id: string;
}

const AXIS_STEPS = [-1, 0, 1] as const;

export function getViewCubeAxisLabels(
  convention: ViewCubeSceneConvention,
): ViewCubeAxisLabels {
  if (convention === "swapYZ") {
    return {
      x: "+X",
      y: "+Z",
      z: "+Y",
    };
  }

  return {
    x: "+X",
    y: "+Y",
    z: "+Z",
  };
}

export function buildViewCubeTargetMap(
  convention: ViewCubeSceneConvention,
): Map<string, ViewCubeTarget> {
  const targets = new Map<string, ViewCubeTarget>();

  for (const x of AXIS_STEPS) {
    for (const y of AXIS_STEPS) {
      for (const z of AXIS_STEPS) {
        if (x === 0 && y === 0 && z === 0) {
          continue;
        }

        const id = viewCubeTargetId(x, y, z);
        targets.set(id, {
          direction: directionForConvention(convention, [x, y, z]),
          id,
        });
      }
    }
  }

  return targets;
}

function directionForConvention(
  convention: ViewCubeSceneConvention,
  direction: [number, number, number],
): [number, number, number] {
  if (convention === "swapYZ") {
    return [direction[0], direction[2], direction[1]];
  }

  return direction;
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
