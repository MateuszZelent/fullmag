import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INSTANCE_TAB_FRAME_NAME } from "./instanceTabs";
import {
  INSTANCE_TAB_READY_MESSAGE,
  INSTANCE_TAB_VISIBILITY_MESSAGE,
  answerInstanceTabReady,
  instanceTabVisibility,
  isInstanceTabHostOrigin,
  listenForInstanceTabVisibility,
  parseInstanceTabPortWindow,
  postInstanceTabFramesVisibility,
  readInstanceTabVisibility,
  useInstanceTabHidden,
} from "./instanceTabVisibility";

const PORTS = { first: 3197, last: 3260 };
const HOST = "http://localhost:3199";

function visibility(visible: boolean) {
  return { type: INSTANCE_TAB_VISIBILITY_MESSAGE, visible };
}

function fakeFrameWindow({
  // null stands for a browser without `location.ancestorOrigins` (Firefox).
  ancestorOrigins = [HOST] as string[] | null,
  name = INSTANCE_TAB_FRAME_NAME,
  referrer = "",
} = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const parent = { postMessage: vi.fn() };
  const target = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.add(listener);
    },
    document: { referrer },
    location: ancestorOrigins === null ? {} : { ancestorOrigins },
    name,
    parent,
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.delete(listener);
    },
  };
  const deliver = (message: { data: unknown; origin: string; source: unknown }) => {
    for (const listener of listeners) listener(message as MessageEvent);
  };
  return { deliver, listeners, parent, target: target as unknown as Window };
}

function fakeFrame() {
  return { contentWindow: { postMessage: vi.fn() } as unknown as Window };
}

function HiddenProbe() {
  return <span>{useInstanceTabHidden() ? "hidden" : "visible"}</span>;
}

afterEach(() => instanceTabVisibility.resetForTests());

describe("instance tab port window", () => {
  it("parses the window next.config publishes and nothing else", () => {
    expect(parseInstanceTabPortWindow("3197-3260")).toEqual(PORTS);
    expect(parseInstanceTabPortWindow("4000-4000")).toEqual({ first: 4000, last: 4000 });
    for (const value of [undefined, "", "3260-3197", "0-10", "1-70000", " 3197-3260", "3197", "a-b"]) {
      expect(parseInstanceTabPortWindow(value)).toBeNull();
    }
  });

  it("trusts only http loopback origins inside the window", () => {
    expect(isInstanceTabHostOrigin("http://127.0.0.1:3197", PORTS)).toBe(true);
    expect(isInstanceTabHostOrigin("http://localhost:3260", PORTS)).toBe(true);
    for (const origin of [
      "http://localhost:3196",
      "http://localhost:3261",
      "https://localhost:3199",
      "http://example.com:3199",
      "http://[::1]:3199",
      "http://localhost:3199/workspace",
      "http://localhost",
      "null",
      "",
    ]) {
      expect(isInstanceTabHostOrigin(origin, PORTS)).toBe(false);
    }
    expect(isInstanceTabHostOrigin(HOST, null)).toBe(false);
  });
});

describe("readInstanceTabVisibility", () => {
  const parent = {};
  const frame = { name: INSTANCE_TAB_FRAME_NAME, parent };

  it("reads visibility from the parent page of a named frame", () => {
    expect(readInstanceTabVisibility({ data: visibility(false), origin: HOST, source: parent }, frame, PORTS)).toBe(false);
    expect(readInstanceTabVisibility({ data: visibility(true), origin: HOST, source: parent }, frame, PORTS)).toBe(true);
  });

  it("ignores any other receiver, sender, origin or payload", () => {
    const valid = { data: visibility(false), origin: HOST, source: parent };
    expect(readInstanceTabVisibility(valid, { name: "", parent }, PORTS)).toBeNull();
    expect(readInstanceTabVisibility({ ...valid, source: {} }, frame, PORTS)).toBeNull();
    expect(readInstanceTabVisibility({ ...valid, origin: "http://localhost:8080" }, frame, PORTS)).toBeNull();
    expect(readInstanceTabVisibility({ ...valid, origin: "https://localhost:3199" }, frame, PORTS)).toBeNull();
    expect(readInstanceTabVisibility(valid, frame, null)).toBeNull();
    for (const data of [null, "hidden", { type: "other", visible: false }, { type: INSTANCE_TAB_VISIBILITY_MESSAGE }, { type: INSTANCE_TAB_VISIBILITY_MESSAGE, visible: "false" }]) {
      expect(readInstanceTabVisibility({ ...valid, data }, frame, PORTS)).toBeNull();
    }
  });
});

describe("instanceTabVisibility store", () => {
  it("notifies only on a change and renders visible on the server", () => {
    const listener = vi.fn();
    const unsubscribe = instanceTabVisibility.subscribe(listener);
    instanceTabVisibility.setVisible(true);
    expect(listener).not.toHaveBeenCalled();
    instanceTabVisibility.setVisible(false);
    instanceTabVisibility.setVisible(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(instanceTabVisibility.hidden()).toBe(true);

    // The first render must match SSR even when the tab is already hidden.
    expect(renderToStaticMarkup(<HiddenProbe />)).toBe("<span>visible</span>");

    instanceTabVisibility.setVisible(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("listenForInstanceTabVisibility", () => {
  it("does nothing outside an instance tab frame", () => {
    const frame = fakeFrameWindow({ name: "" });
    const stop = listenForInstanceTabVisibility(frame.target, PORTS);
    expect(frame.listeners.size).toBe(0);
    expect(frame.parent.postMessage).not.toHaveBeenCalled();
    stop();
  });

  it("asks the host for the state and applies only valid host messages", () => {
    const frame = fakeFrameWindow();
    const stop = listenForInstanceTabVisibility(frame.target, PORTS);
    expect(frame.parent.postMessage).toHaveBeenCalledWith({ type: INSTANCE_TAB_READY_MESSAGE }, HOST);

    frame.deliver({ data: visibility(false), origin: HOST, source: {} });
    frame.deliver({ data: visibility(false), origin: "http://localhost:9000", source: frame.parent });
    expect(instanceTabVisibility.hidden()).toBe(false);

    frame.deliver({ data: visibility(false), origin: HOST, source: frame.parent });
    expect(instanceTabVisibility.hidden()).toBe(true);
    frame.deliver({ data: visibility(true), origin: HOST, source: frame.parent });
    expect(instanceTabVisibility.hidden()).toBe(false);

    frame.deliver({ data: visibility(false), origin: HOST, source: frame.parent });
    stop();
    expect(frame.listeners.size).toBe(0);
    expect(instanceTabVisibility.hidden()).toBe(false);
  });

  it("finds the host by referrer without ancestorOrigins and never asks a foreign page", () => {
    const firefox = fakeFrameWindow({ ancestorOrigins: null, referrer: "http://127.0.0.1:3200/" });
    listenForInstanceTabVisibility(firefox.target, PORTS)();
    expect(firefox.parent.postMessage).toHaveBeenCalledWith(
      { type: INSTANCE_TAB_READY_MESSAGE },
      "http://127.0.0.1:3200",
    );

    const foreign = fakeFrameWindow({ ancestorOrigins: ["http://localhost:8888"] });
    listenForInstanceTabVisibility(foreign.target, PORTS)();
    const unknown = fakeFrameWindow({ ancestorOrigins: null, referrer: "" });
    listenForInstanceTabVisibility(unknown.target, PORTS)();
    expect(foreign.parent.postMessage).not.toHaveBeenCalled();
    expect(unknown.parent.postMessage).not.toHaveBeenCalled();
  });
});

describe("host side", () => {
  const originOf = (port: number) => `http://localhost:${port}`;

  it("tells each mounted frame, at its own origin, whether its tab is in front", () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const frames = new Map([[3206, first], [3210, second]]);

    postInstanceTabFramesVisibility(frames, originOf, 3210);
    expect(first.contentWindow.postMessage).toHaveBeenCalledWith(visibility(false), "http://localhost:3206");
    expect(second.contentWindow.postMessage).toHaveBeenCalledWith(visibility(true), "http://localhost:3210");

    postInstanceTabFramesVisibility(frames, originOf, null);
    expect(second.contentWindow.postMessage).toHaveBeenLastCalledWith(visibility(false), "http://localhost:3210");
  });

  it("answers ready only for a mounted frame's window from its own origin", () => {
    const frame = fakeFrame();
    const frames = new Map([[3206, frame]]);
    const ready = { type: INSTANCE_TAB_READY_MESSAGE };

    answerInstanceTabReady({ data: ready, origin: "http://localhost:3206", source: {} }, frames, originOf, 3206);
    answerInstanceTabReady({ data: ready, origin: "http://localhost:3210", source: frame.contentWindow }, frames, originOf, 3206);
    answerInstanceTabReady({ data: { type: "other" }, origin: "http://localhost:3206", source: frame.contentWindow }, frames, originOf, 3206);
    expect(frame.contentWindow.postMessage).not.toHaveBeenCalled();

    answerInstanceTabReady({ data: ready, origin: "http://localhost:3206", source: frame.contentWindow }, frames, originOf, null);
    expect(frame.contentWindow.postMessage).toHaveBeenCalledWith(visibility(false), "http://localhost:3206");
  });
});
