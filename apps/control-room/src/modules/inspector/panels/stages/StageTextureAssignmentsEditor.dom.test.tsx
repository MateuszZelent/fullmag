import { act, useState } from "react";
import { describe, expect, it } from "vitest";

import type { JsonValue, SceneResource } from "@/kernel/api/apiTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
  TestHTMLSelectElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { StageTextureAssignmentsEditor } from "./StageTextureAssignmentsEditor";

describe("stage texture assignment editor", () => {
  it("adds the chosen region to the draft and preserves an explicit repeat", async () => {
    const scene = {
      revision: 12,
      objects: [{ id: "film", name: "Film", role: "magnet", regions: [
        { region_id: "core", name: "Core", shape: { kind: "box", size: [1, 1, 1] } },
      ] }],
    } as SceneResource;
    const changes: (JsonValue | undefined)[] = [];
    function Editor() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState<JsonValue | undefined>();
      return <StageTextureAssignmentsEditor
        disabledReason={null}
        onChange={(next) => { changes.push(next); setValue(next); }}
        onOpenChange={setOpen}
        open={open}
        scene={scene}
        value={value}
      />;
    }

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const button = (label: string) => findElement(container,
      (element) => element.tagName === "BUTTON" && element.textContent === label, label);
    const select = (label: string) => findElement(container,
      (element) => element.tagName === "SELECT" && element.getAttribute("aria-label") === label,
      label,
    ) as TestHTMLSelectElement;
    try {
      await act(async () => root.render(<Editor />));
      await act(async () => button("Add texture change").click());
      await act(async () => {
        select("Apply to").value = "core";
        select("Apply to").dispatchEvent(new TestEvent("change", { bubbles: true }));
      });
      for (let index = 0; index < 2; index += 1) {
        await act(async () => {
          select("Texture").value = "reset";
          select("Texture").dispatchEvent(new TestEvent("change", { bubbles: true }));
        });
        await act(async () => button("Add to stage").click());
        if (index === 0) await act(async () => button("Add texture change").click());
      }
      const assignment = { object_id: "film", region_id: "core", initializer: null };
      expect(changes).toEqual([
        { schema_version: "fullmag.magnetization-assignments.v1", assignments: [assignment] },
        { schema_version: "fullmag.magnetization-assignments.v1", assignments: [assignment, assignment] },
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
