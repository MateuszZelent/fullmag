import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import {
  installViewport3DThreeConsolePolicy,
  resetViewport3DThreeConsolePolicyForTests,
  VIEWPORT_3D_THREE_CLOCK_DEPRECATION_WARNING,
} from "./viewport3dThreeConsolePolicy";

type ThreeConsoleFunction = (
  type: "error" | "log" | "warn",
  message: string,
  ...params: unknown[]
) => void;

const threeConsole = THREE as unknown as {
  getConsoleFunction: () => ThreeConsoleFunction | null;
  setConsoleFunction: (fn: ThreeConsoleFunction | null) => void;
};

describe("viewport3dThreeConsolePolicy", () => {
  afterEach(() => {
    resetViewport3DThreeConsolePolicyForTests();
    threeConsole.setConsoleFunction(null);
  });

  it("suppresses only the known Three Clock deprecation warning", () => {
    const previous = vi.fn<ThreeConsoleFunction>();
    threeConsole.setConsoleFunction(previous);

    installViewport3DThreeConsolePolicy();
    const handler = threeConsole.getConsoleFunction();

    handler?.("warn", VIEWPORT_3D_THREE_CLOCK_DEPRECATION_WARNING);
    handler?.("warn", "THREE.WebGLRenderer: context lost");
    handler?.("error", "THREE.WebGLRenderer: failed");

    expect(previous).toHaveBeenCalledTimes(2);
    expect(previous).toHaveBeenNthCalledWith(
      1,
      "warn",
      "THREE.WebGLRenderer: context lost",
    );
    expect(previous).toHaveBeenNthCalledWith(
      2,
      "error",
      "THREE.WebGLRenderer: failed",
    );
  });

  it("is idempotent across repeated viewport module evaluation", () => {
    const previous = vi.fn<ThreeConsoleFunction>();
    threeConsole.setConsoleFunction(previous);

    installViewport3DThreeConsolePolicy();
    const first = threeConsole.getConsoleFunction();
    installViewport3DThreeConsolePolicy();
    const second = threeConsole.getConsoleFunction();

    expect(second).toBe(first);
  });
});
