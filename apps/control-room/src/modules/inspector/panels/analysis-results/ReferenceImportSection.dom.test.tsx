import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
  type TestElement,
  type TestHTMLOptionElement,
  type TestHTMLSelectElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { MAX_REFERENCE_FILE_BYTES } from "@/shared/domain/analysis/referenceImport";

import { ReferenceImportSection } from "./ReferenceImportSection";

type TestReferenceFile = Pick<File, "name" | "size" | "text">;

function referenceFile(name: string, size: number, text: () => Promise<string>): TestReferenceFile {
  return { name, size, text };
}

function chooseFile(input: TestElement, file: TestReferenceFile): void {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

async function flushRead(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ReferenceImportSection file selection", () => {
  it("matches simple selectors and searches closest from self through element ancestors", () => {
    const dom = installSimulationPreparationTestDom();
    try {
      const form = dom.document.createElement("form");
      const section = dom.document.createElement("section");
      section.setAttribute("class", "reference-import");
      const trigger = dom.document.createElement("button");
      form.appendChild(section);
      section.appendChild(trigger);

      expect(form.matches("form")).toBe(true);
      expect(section.matches(".reference-import")).toBe(true);
      expect(trigger.matches("form")).toBe(false);
      expect(dom.document.createElement("fm-result-panel").matches("fm-result-panel")).toBe(true);
      expect(form.closest("form")).toBe(form);
      expect(trigger.closest("button")).toBe(trigger);
      expect(trigger.closest(".reference-import")).toBe(section);
      expect(trigger.closest("form")).toBe(form);
      expect(trigger.closest("dialog")).toBeNull();
      expect(trigger.closest(".missing-ancestor")).toBeNull();
      for (const unsupportedSelector of [".", ".reference-import.foo", "form button", "button:hover"]) {
        expect(trigger.matches(unsupportedSelector)).toBe(false);
        expect(trigger.closest(unsupportedSelector)).toBeNull();
      }

      const detached = dom.document.createElement("button");
      expect(detached.closest("form")).toBeNull();

      const fragmentConstructor = dom.document.defaultView?.DocumentFragment as
        | (new () => { nodeType: number; ownerDocument: unknown })
        | undefined;
      if (!fragmentConstructor) {
        throw new Error("The test DOM must expose the native DocumentFragment constructor used by Radix Select.");
      }
      const fragment = new fragmentConstructor();
      expect(fragment.nodeType).toBe(11);
      expect(fragment.ownerDocument).toBe(dom.document);
    } finally {
      dom.restore();
    }
  });

  it("reflects option values and selectedness through a native select", () => {
    const dom = installSimulationPreparationTestDom();
    const option = (value: string): TestHTMLOptionElement => {
      const element = dom.document.createElement("option") as TestHTMLOptionElement;
      element.value = value;
      element.textContent = `Label ${value}`;
      return element;
    };

    try {
      const reflectedOption = dom.document.createElement("option") as TestHTMLOptionElement;
      reflectedOption.setAttribute("value", "attribute-value");
      reflectedOption.textContent = "Text fallback";
      expect(reflectedOption.value).toBe("attribute-value");
      reflectedOption.removeAttribute("value");
      expect(reflectedOption.value).toBe("Text fallback");
      reflectedOption.value = "property-value";
      expect(reflectedOption.getAttribute("value")).toBe("property-value");

      reflectedOption.defaultSelected = true;
      expect(reflectedOption.hasAttribute("selected")).toBe(true);
      expect(reflectedOption.selected).toBe(true);
      reflectedOption.selected = false;
      expect(reflectedOption.selected).toBe(false);
      expect(reflectedOption.defaultSelected).toBe(true);
      reflectedOption.defaultSelected = false;
      expect(reflectedOption.hasAttribute("selected")).toBe(false);
      expect(reflectedOption.selected).toBe(false);

      const select = dom.document.createElement("select") as TestHTMLSelectElement;
      const disabledDirect = option("disabled-direct");
      disabledDirect.setAttribute("disabled", "");
      const disabledGroup = dom.document.createElement("optgroup");
      disabledGroup.setAttribute("disabled", "");
      disabledGroup.appendChild(option("disabled-group"));
      const group = dom.document.createElement("optgroup");
      const firstEnabled = option("first-enabled");
      const secondEnabled = option("second-enabled");
      group.appendChild(firstEnabled);
      group.appendChild(secondEnabled);
      select.appendChild(disabledDirect);
      select.appendChild(disabledGroup);
      select.appendChild(group);

      expect(select.options.map((item) => item.value)).toEqual([
        "disabled-direct", "disabled-group", "first-enabled", "second-enabled",
      ]);
      expect(select.value).toBe("first-enabled");
      expect(select.selectedIndex).toBe(2);
      expect(firstEnabled.selected).toBe(true);

      select.value = "second-enabled";
      expect(select.value).toBe("second-enabled");
      expect(select.selectedIndex).toBe(3);
      expect(firstEnabled.selected).toBe(false);
      expect(secondEnabled.selected).toBe(true);

      firstEnabled.selected = true;
      expect(select.value).toBe("first-enabled");
      expect(select.selectedIndex).toBe(2);
      expect(firstEnabled.selected).toBe(true);
      expect(secondEnabled.selected).toBe(false);

      disabledDirect.selected = true;
      expect(select.value).toBe("disabled-direct");
      expect(select.selectedIndex).toBe(0);
      expect(disabledDirect.selected).toBe(true);
      expect(firstEnabled.selected).toBe(false);

      select.value = "unmatched-value";
      expect(select.value).toBe("");
      expect(select.selectedIndex).toBe(-1);
      expect(select.options.every((item) => !item.selected)).toBe(true);
    } finally {
      dom.restore();
    }
  });

  it("clears old table data and fences pending and immediate results by newest selection", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const kernel = {} as unknown as KernelApi;
    let resolveSlowRead!: (text: string) => void;
    const slowText = new Promise<string>((resolve) => { resolveSlowRead = resolve; });
    const slowFile = referenceFile("older.csv", 24, vi.fn(() => slowText));
    const oversizedText = vi.fn().mockResolvedValue("must not be read");
    const oversizedFile = referenceFile("oversized.csv", MAX_REFERENCE_FILE_BYTES + 1, oversizedText);
    const validText = vi.fn().mockResolvedValue("s,f\n1,2\n3,4\n");
    const validFile = referenceFile("current.csv", MAX_REFERENCE_FILE_BYTES, validText);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <ReferenceImportSection />
          </KernelContext.Provider>,
        );
      });
      const input = findElement(
        container,
        (element) => element.tagName.toLowerCase() === "input" && element.getAttribute("aria-label") === "Reference file",
        "Reference file input",
      );
      const trigger = findElement(
        container,
        (element) => element.tagName.toLowerCase() === "button" && element.textContent.includes("Import reference"),
        "Import reference group trigger",
      );
      // The production Inspector is not inside a form. Radix 2.2.6 omits its
      // native bubble select in this real non-form path.
      expect(trigger.closest("form")).toBeNull();
      await act(async () => { trigger.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const content = findElement(
        container,
        (element) => element.getAttribute("data-slot") === "inspector-group-content",
        "Import reference group content",
      );
      expect(content.hasAttribute("hidden")).toBe(false);

      // The first read resolves with an immediate size error; the same turn chooses a newer valid file.
      await act(async () => {
        chooseFile(input, oversizedFile);
        chooseFile(input, validFile);
        await flushRead();
      });
      expect(oversizedText).not.toHaveBeenCalled();
      expect(container.textContent).toContain("2 points.");
      expect(container.textContent).not.toContain("4 MiB or smaller");
      const columnSelects = findElements(
        container,
        (element) => element.tagName.toLowerCase() === "select",
      );
      expect(columnSelects).toHaveLength(0);

      await act(async () => { chooseFile(input, slowFile); });
      expect(container.textContent).not.toContain("2 points.");
      await act(async () => {
        chooseFile(input, oversizedFile);
        await flushRead();
      });
      expect(container.textContent).toContain("4 MiB or smaller");
      expect(container.textContent).not.toContain("2 points.");

      await act(async () => {
        resolveSlowRead("s,f\n8,9\n10,11\n");
        await flushRead();
      });
      expect(container.textContent).toContain("4 MiB or smaller");
      expect(container.textContent).not.toContain("2 points.");
      expect(container.textContent).not.toContain("older.csv");
      expect(slowFile.text).toHaveBeenCalledTimes(1);
      expect(oversizedText).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses the native bubble-select prototype only with an actual form ancestor", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const kernel = {} as unknown as KernelApi;

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            {/* Radix 2.2.6 mounts its native bubble input only for a form-associated trigger. */}
            <form><ReferenceImportSection /></form>
          </KernelContext.Provider>,
        );
      });
      const trigger = findElement(
        container,
        (element) => element.tagName.toLowerCase() === "button" && element.textContent.includes("Import reference"),
        "Import reference group trigger inside form",
      );
      expect(trigger.closest("form")?.tagName).toBe("FORM");
      await act(async () => { trigger.dispatchEvent(new TestEvent("click", { bubbles: true })); });

      const input = findElement(
        container,
        (element) => element.tagName.toLowerCase() === "input" && element.getAttribute("aria-label") === "Reference file",
        "Reference file input inside form",
      );
      const validText = vi.fn().mockResolvedValue("s,f\n1,2\n3,4\n");
      await act(async () => {
        chooseFile(input, referenceFile("native-select.csv", 12, validText));
        await flushRead();
      });

      const nativeSelectConstructor = dom.document.defaultView?.HTMLSelectElement as
        | { prototype: object }
        | undefined;
      if (!nativeSelectConstructor) {
        throw new Error("The test DOM must expose its native select constructor.");
      }
      expect(Object.getOwnPropertyDescriptor(nativeSelectConstructor.prototype, "value")?.set)
        .toBeTypeOf("function");
      const columnSelects = findElements(
        container,
        (element) => element.tagName.toLowerCase() === "select",
      );
      expect(columnSelects).toHaveLength(2);
      expect(columnSelects.every(
        (element) => Object.getPrototypeOf(element) === nativeSelectConstructor.prototype,
      )).toBe(true);
      expect(columnSelects.map((element) => element.value)).toEqual(["0", "1"]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
