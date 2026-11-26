// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";

import { ScalarColorbarControl } from "./ObjectVisualizationTargetSection";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderManualRange(patch: ReturnType<typeof vi.fn>) {
  await act(async () => root.render(
    <ScalarColorbarControl
      disabled={false}
      fieldMeta={{
        data: {
          quantity_id: "H_ex",
          stats: { max: 4, min: -3 },
          unit: "A/m",
        },
        status: "ready",
      } as ReturnType<typeof useFieldMetaResource>}
      palette="viridis"
      patch={patch}
      quantityId="H_ex"
      rangeIdentity="surface:H_ex:magnitude:object:film"
      rangePreferenceComponent="magnitude"
      renderedRange={{ max: 1, min: -1 }}
      scalarRangePolicy={{
        max: 1,
        min: -1,
        mode: "manual",
        scale: "linear",
        symmetric: false,
      }}
    />,
  ));
}

function rangeInput(label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`missing ${label} input`);
  return input;
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ScalarColorbarControl manual range commits", () => {
  it("keeps edits local until Apply commits the signed limits together", async () => {
    const patch = vi.fn();
    await renderManualRange(patch);
    await changeInput(rangeInput("Manual color range minimum"), "-2");

    expect(patch).not.toHaveBeenCalled();

    const apply = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply range",
    );
    if (!apply) throw new Error("missing Apply range button");
    await act(async () => apply.click());

    expect(patch).toHaveBeenCalledExactlyOnceWith({
      scalarRangePreference: {
        component: "magnitude",
        policy: {
          max: 1,
          min: -2,
          mode: "manual",
          scale: "linear",
          symmetric: false,
        },
        quantityId: "H_ex",
      },
    });
  });

  it("applies a valid draft when Enter is pressed", async () => {
    const patch = vi.fn();
    await renderManualRange(patch);
    const maxInput = rangeInput("Manual color range maximum");
    await changeInput(maxInput, "2.5");
    await act(async () => {
      maxInput.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
      }));
    });

    expect(patch).toHaveBeenCalledExactlyOnceWith({
      scalarRangePreference: {
        component: "magnitude",
        policy: {
          max: 2.5,
          min: -1,
          mode: "manual",
          scale: "linear",
          symmetric: false,
        },
        quantityId: "H_ex",
      },
    });
  });
});
