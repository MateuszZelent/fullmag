import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

export { findElement, findElements, type TestElement, TestEvent };

export function mountWave4TestElement(initial: ReactElement) {
  const dom = installSimulationPreparationTestDom();
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);

  act(() => {
    root.render(initial);
  });

  return {
    host: host as unknown as TestElement,
    rerender(next: ReactElement) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      dom.restore();
    },
  };
}
