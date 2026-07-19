type TestListener = (event: TestEvent) => void;

export class TestEvent {
  bubbles: boolean;
  cancelable = true;
  currentTarget: TestNode | null = null;
  defaultPrevented = false;
  readonly key?: string;
  readonly type: string;
  target: TestNode | null = null;
  private propagationStopped = false;

  constructor(type: string, init: { bubbles?: boolean; key?: string } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.key = init.key;
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

export class TestNode {
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

  contains(candidate: TestNode | null): boolean {
    let current = candidate;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
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

export class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  clientHeight = 0;
  clientWidth = 0;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  offsetHeight = 0;
  offsetWidth = 0;
  scrollHeight = 0;
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 0;
  readonly style: Record<string, string> & {
    removeProperty: (name: string) => void;
    setProperty: (name: string, value: string) => void;
  };
  readonly tagName: string;

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    const style = Object.create(null) as TestElement["style"];
    style.removeProperty = (name: string) => {
      Reflect.deleteProperty(style, name);
    };
    style.setProperty = (name: string, value: string) => {
      style[name] = value;
    };
    this.style = style;
  }

  click(): void {
    this.dispatchEvent(new TestEvent("click", { bubbles: true }));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect(): DOMRect {
    return {
      bottom: this.clientHeight,
      height: this.clientHeight,
      left: 0,
      right: this.clientWidth,
      top: 0,
      width: this.clientWidth,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  matches(selector: string): boolean {
    if (selector.startsWith(".")) {
      return (this.getAttribute("class") ?? "")
        .split(/\s+/)
        .includes(selector.slice(1));
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelector<TElement extends TestElement = TestElement>(
    selector: string,
  ): TElement | null {
    return findElements(this, (element) => element !== this && element.matches(selector))[0] as
      | TElement
      | undefined ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
}

export class TestDocument extends TestNode {
  activeElement: TestElement | null = null;
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

export function findElement(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
  description: string,
): TestElement {
  const element = findElements(root, predicate)[0];
  if (!element) throw new Error(`${description} was not rendered.`);
  return element;
}

export function findElements(
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

export function installSimulationPreparationTestDom({
  clipboard,
}: {
  clipboard?: { writeText: (value: string) => Promise<void> };
} = {}): {
  document: TestDocument;
  restore: () => void;
} {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const document = new TestDocument();
  class TestHtmlIFrameElement extends TestElement {}
  class TestResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  }
  class TestMutationObserver {
    disconnect(): void {}
    observe(): void {}
    takeRecords(): never[] {
      return [];
    }
  }
  const getComputedStyle = () => ({ direction: "ltr" });
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  const cancelAnimationFrame = () => undefined;
  const navigator = { clipboard };
  const window = {
    document,
    navigator,
    Element: TestElement,
    Event: TestEvent,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    MutationObserver: TestMutationObserver,
    Node: TestNode,
    ResizeObserver: TestResizeObserver,
    cancelAnimationFrame,
    clearTimeout,
    getComputedStyle,
    requestAnimationFrame,
    setTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = window;
  for (const [key, value] of Object.entries({
    document,
    navigator,
    Element: TestElement,
    Event: TestEvent,
    HTMLElement: TestElement,
    MutationObserver: TestMutationObserver,
    Node: TestNode,
    ResizeObserver: TestResizeObserver,
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
