import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  type ObjectMeshPolicyDraft,
  type ObjectMeshTopologyCapabilities,
} from "./ObjectMeshPolicyPanelModel";
import {
  ObjectMeshSizeSemanticsSection,
  ObjectMeshSweepStrategySection,
} from "./ObjectMeshPolicyPanel";

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  AlertTriangle: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  CheckCircle2: () => null,
  HelpCircle: () => null,
}));

const capabilities: ObjectMeshTopologyCapabilities = {
  layeredPrism: {
    enabled: true,
    reason: "Validated for authoring.",
    status: "validated",
  },
  sweptHex: {
    enabled: false,
    reason: "Unsupported.",
    status: "unsupported",
  },
};

describe("ObjectMeshPolicyPanel mounted interaction", () => {
  it("selects canonical exact-prism and free-tetra presets through native controls", async () => {
    const dom = installTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    function Harness() {
      const [draft, setDraft] = useState<ObjectMeshPolicyDraft>(() => ({
        ...draftFromObjectMeshPolicyResource(
          defaultObjectMeshPolicyResource("film"),
        ),
        present: true,
      }));
      return (
        <>
          <ObjectMeshSizeSemanticsSection
            draft={draft}
            updateDraft={(patch) =>
              setDraft((current) => ({ ...current, ...patch }))
            }
          />
          <ObjectMeshSweepStrategySection
            capabilities={capabilities}
            draft={draft}
            updateDraft={(patch) =>
              setDraft((current) => ({ ...current, ...patch }))
            }
          />
          <pre data-testid="draft">{JSON.stringify(draft)}</pre>
        </>
      );
    }

    await act(async () => root.render(<Harness />));
    const strategy = findControl(container, "Mesh strategy");

    await act(async () => change(strategy, "swept_prism"));
    expect(readDraft(container)).toMatchObject({
      exactLayerCount: "true",
      meshStrategy: "swept_prism",
      order: "1",
      sweepFaceMeshing: "triangular",
      throughThicknessDistribution: "fixed",
      throughThicknessElementRatio: "1",
      throughThicknessElements: "1",
      throughThicknessSymmetric: "false",
      topology: "prismatic",
      transitionPolicy: "pyramid_to_tetrahedra",
    });
    expect(findControl(container, "Element layers").disabled).toBe(false);
    expect(findControl(container, "FEM order").disabled).toBe(true);
    expect(findControl(container, "Thickness distribution").disabled).toBe(true);
    expect(findControl(container, "Thickness element ratio").disabled).toBe(true);
    expect(findControl(container, "Symmetric thickness").disabled).toBe(true);
    expect(findControl(container, "Sweep face meshing").disabled).toBe(true);

    expect(optionValues(findControl(container, "Thickness distribution"))).toEqual([
      "",
      "fixed",
      "linear",
      "exponential",
    ]);
    expect(optionValues(findControl(container, "Symmetric thickness"))).toEqual([
      "",
      "true",
      "false",
    ]);
    expect(optionValues(findControl(container, "Sweep face meshing"))).toEqual([
      "",
      "triangular",
      "quadrilateral",
    ]);

    await act(async () => change(strategy, "free_tetrahedral"));
    expect(readDraft(container)).toMatchObject({
      exactLayerCount: "",
      meshStrategy: "free_tetrahedral",
      sweepFaceMeshing: "",
      throughThicknessDistribution: "",
      throughThicknessElementRatio: "",
      throughThicknessElements: "",
      throughThicknessSymmetric: "",
      topology: "",
      transitionPolicy: "",
    });

    await act(async () => root.unmount());
    dom.restore();
  });
});

function change(element: TestElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function findControl(container: TestNode, label: string): TestElement {
  const control = findElements(
    container,
    (element) => element.getAttribute("aria-label") === label,
  )[0];
  if (!control) throw new Error(`Control ${label} was not rendered.`);
  return control;
}

function readDraft(container: TestNode): ObjectMeshPolicyDraft {
  const draft = findElements(
    container,
    (element) => element.getAttribute("data-testid") === "draft",
  )[0];
  if (!draft) throw new Error("Draft state was not rendered.");
  return JSON.parse(draft.textContent) as ObjectMeshPolicyDraft;
}

function optionValues(select: TestElement): Array<string | null> {
  return select.childNodes
    .filter(
      (child): child is TestElement =>
        child instanceof TestElement && child.tagName === "OPTION",
    )
    .map((option) => option.getAttribute("value"));
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

type TestListener = (event: TestEvent) => void;

class TestEvent {
  bubbles: boolean;
  currentTarget: TestNode | null = null;
  defaultPrevented = false;
  readonly type: string;
  target: TestNode | null = null;
  private propagationStopped = false;

  constructor(type: string, init: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  isPropagationStopped(): boolean {
    return this.propagationStopped;
  }
}

class TestNode {
  readonly childNodes: TestNode[] = [];
  ownerDocument: TestDocument;
  parentNode: TestNode | null = null;
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null = null;
  private readonly listeners = new Map<
    string,
    { capture: TestListener[]; bubble: TestListener[] }
  >();

  constructor(ownerDocument: TestDocument, nodeType: number, nodeName: string) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }

  appendChild<T extends TestNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends TestNode>(child: T, before: TestNode | null): T {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }

  removeChild<T extends TestNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(
    type: string,
    listener: TestListener,
    options?: boolean | { capture?: boolean },
  ): void {
    const phase =
      options === true || (typeof options === "object" && options.capture)
        ? "capture"
        : "bubble";
    const listeners = this.listeners.get(type) ?? { capture: [], bubble: [] };
    listeners[phase].push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestListener): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    listeners.capture = listeners.capture.filter((item) => item !== listener);
    listeners.bubble = listeners.bubble.filter((item) => item !== listener);
  }

  dispatchEvent(event: TestEvent): boolean {
    if (!event.target) event.target = this;
    const path: TestNode[] = [this];
    let parent = this.parentNode;
    while (parent) {
      path.push(parent);
      parent = parent.parentNode;
    }
    for (const node of [...path].reverse()) {
      node.invoke(event, "capture");
      if (event.isPropagationStopped()) return !event.defaultPrevented;
    }
    for (const node of path) {
      node.invoke(event, "bubble");
      if (event.isPropagationStopped() || !event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  private invoke(event: TestEvent, phase: "capture" | "bubble"): void {
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type)?.[phase] ?? []) {
      listener.call(this, event);
    }
  }
}

class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style: Record<string, string> & {
    setProperty: (name: string, value: string) => void;
  };
  readonly tagName: string;
  value = "";

  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set("disabled", "");
    else this.attributes.delete("disabled");
  }

  get options(): TestElement[] {
    return this.childNodes.filter(
      (child): child is TestElement =>
        child instanceof TestElement && child.tagName === "OPTION",
    );
  }

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    const style = Object.create(null) as TestElement["style"];
    style.setProperty = (name: string, value: string) => {
      style[name] = value;
    };
    this.style = style;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
}

class TestDocument extends TestNode {
  readonly body: TestElement;
  readonly documentElement: TestElement;
  defaultView: Record<string, unknown> | null = null;

  constructor() {
    super(null as unknown as TestDocument, 9, "#document");
    this.ownerDocument = this;
    this.documentElement = new TestElement(this, "html");
    this.body = new TestElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  createComment(value: string): TestNode {
    const node = new TestNode(this, 8, "#comment");
    node.nodeValue = value;
    return node;
  }

  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName);
  }

  createTextNode(value: string): TestNode {
    const node = new TestNode(this, 3, "#text");
    node.nodeValue = value;
    return node;
  }
}

function installTestDom(): { document: TestDocument; restore: () => void } {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const document = new TestDocument();
  class TestHtmlIFrameElement extends TestElement {}
  const getComputedStyle = () => ({ direction: "ltr" });
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  const cancelAnimationFrame = () => undefined;
  const window = {
    document,
    Element: TestElement,
    Event: TestEvent,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    Node: TestNode,
    cancelAnimationFrame,
    getComputedStyle,
    requestAnimationFrame,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = window;
  for (const [key, value] of Object.entries({
    document,
    Element: TestElement,
    Event: TestEvent,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    Node: TestNode,
    cancelAnimationFrame,
    getComputedStyle,
    requestAnimationFrame,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return {
    document,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
