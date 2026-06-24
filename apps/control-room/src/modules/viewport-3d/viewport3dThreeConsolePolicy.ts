import * as THREE from "three";

export const VIEWPORT_3D_THREE_CLOCK_DEPRECATION_WARNING =
  "THREE.THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.";

type ThreeConsoleMessageType = "error" | "log" | "warn";
type ThreeConsoleFunction = (
  type: ThreeConsoleMessageType,
  message: string,
  ...params: unknown[]
) => void;

const threeConsole = THREE as unknown as {
  getConsoleFunction?: () => ThreeConsoleFunction | null;
  setConsoleFunction?: (fn: ThreeConsoleFunction | null) => void;
};

let installed = false;
let previousConsoleFunction: ThreeConsoleFunction | null = null;
let viewport3DConsoleFunction: ThreeConsoleFunction | null = null;

export function installViewport3DThreeConsolePolicy(): void {
  if (
    installed ||
    typeof threeConsole.getConsoleFunction !== "function" ||
    typeof threeConsole.setConsoleFunction !== "function"
  ) {
    return;
  }

  previousConsoleFunction = threeConsole.getConsoleFunction();
  viewport3DConsoleFunction = (type, message, ...params) => {
    if (
      type === "warn" &&
      message === VIEWPORT_3D_THREE_CLOCK_DEPRECATION_WARNING
    ) {
      return;
    }

    if (previousConsoleFunction) {
      previousConsoleFunction(type, message, ...params);
      return;
    }

    console[type](message, ...params);
  };
  threeConsole.setConsoleFunction(viewport3DConsoleFunction);
  installed = true;
}

export function resetViewport3DThreeConsolePolicyForTests(): void {
  if (
    installed &&
    typeof threeConsole.setConsoleFunction === "function"
  ) {
    threeConsole.setConsoleFunction(previousConsoleFunction);
  }
  installed = false;
  previousConsoleFunction = null;
  viewport3DConsoleFunction = null;
}
