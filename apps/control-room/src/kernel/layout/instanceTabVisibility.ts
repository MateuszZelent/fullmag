import { useSyncExternalStore } from "react";

import { INSTANCE_TAB_FRAME_NAME } from "./instanceTabs";

/**
 * Whether this Control Room's instance tab is in front on the host page
 * (ADR 0069, decision 5). The host hides inactive frames with CSS, and inside
 * a frame `document.visibilityState` stays `visible`, so the host tells each
 * frame when its tab leaves or returns to the front. A hidden frame pauses its
 * viewport and resource loads; the session, its run and the realtime
 * connection keep going.
 *
 * Both directions name an explicit target origin, never `*`:
 * - host to frame: `{type: "fullmag.instance-tab.visibility", visible}` when a
 *   tab is activated or deactivated, when a frame loads, and in answer to
 *   `ready`;
 * - frame to host: `{type: "fullmag.instance-tab.ready"}` once the frame
 *   listens, because its scripts may start after the frame's `load` event.
 */
export const INSTANCE_TAB_VISIBILITY_MESSAGE = "fullmag.instance-tab.visibility";
export const INSTANCE_TAB_READY_MESSAGE = "fullmag.instance-tab.ready";

export interface InstanceTabPortWindow {
  readonly first: number;
  readonly last: number;
}

/**
 * Parses `<first>-<last>` as `next.config.ts` publishes the discovery window
 * that its CSP lists. Anything else yields null, and no host is trusted.
 */
export function parseInstanceTabPortWindow(
  value: string | undefined,
): InstanceTabPortWindow | null {
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(value ?? "");
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  return first >= 1 && last <= 65_535 && first <= last ? { first, last } : null;
}

const PORT_WINDOW = parseInstanceTabPortWindow(process.env.FULLMAG_INSTANCE_TAB_PORTS);

/** Whether `origin` is a loopback Control Room in the discovery window. */
export function isInstanceTabHostOrigin(
  origin: string,
  ports: InstanceTabPortWindow | null,
): boolean {
  if (ports === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // A serialized origin has no path, credentials or default port to normalize.
  if (url.origin !== origin || url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  const port = Number(url.port);
  return port >= ports.first && port <= ports.last;
}

interface ReceivedMessage {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

interface ReceivingWindow {
  readonly name: string;
  readonly parent: unknown;
}

function messageType(data: unknown): unknown {
  return typeof data === "object" && data !== null ? (data as { type?: unknown }).type : undefined;
}

/**
 * The visibility a host message sets, or null when it is not a valid one. It
 * must reach a named instance tab frame, come from that frame's parent window
 * and from a loopback origin in the discovery window.
 */
export function readInstanceTabVisibility(
  event: ReceivedMessage,
  receiver: ReceivingWindow,
  ports: InstanceTabPortWindow | null = PORT_WINDOW,
): boolean | null {
  if (receiver.name !== INSTANCE_TAB_FRAME_NAME || event.source !== receiver.parent) return null;
  if (!isInstanceTabHostOrigin(event.origin, ports)) return null;
  if (messageType(event.data) !== INSTANCE_TAB_VISIBILITY_MESSAGE) return null;
  const { visible } = event.data as { visible?: unknown };
  return typeof visible === "boolean" ? visible : null;
}

type TabFrame = Pick<HTMLIFrameElement, "contentWindow">;

/** Tells one mounted frame whether its tab is in front. */
export function postInstanceTabVisibility(frame: TabFrame, origin: string, visible: boolean): void {
  // A frame still on about:blank or on another origin drops the message.
  frame.contentWindow?.postMessage({ type: INSTANCE_TAB_VISIBILITY_MESSAGE, visible }, origin);
}

/** Tells every mounted frame, keyed by instance port, whether its tab is in front. */
export function postInstanceTabFramesVisibility(
  frames: ReadonlyMap<number, TabFrame>,
  originOf: (port: number) => string,
  activePort: number | null,
): void {
  for (const [port, frame] of frames) {
    postInstanceTabVisibility(frame, originOf(port), port === activePort);
  }
}

/**
 * Answers a frame's `ready` with its tab's state. Only a mounted frame's own
 * window from its instance origin gets an answer; other messages are ignored.
 */
export function answerInstanceTabReady(
  event: ReceivedMessage,
  frames: ReadonlyMap<number, TabFrame>,
  originOf: (port: number) => string,
  activePort: number | null,
): void {
  if (messageType(event.data) !== INSTANCE_TAB_READY_MESSAGE) return;
  for (const [port, frame] of frames) {
    const origin = originOf(port);
    if (event.source === frame.contentWindow && event.origin === origin) {
      postInstanceTabVisibility(frame, origin, port === activePort);
    }
  }
}

type Listener = () => void;

const listeners = new Set<Listener>();
let hidden = false;

export const instanceTabVisibility = {
  /** True while the host page keeps this frame's tab out of view. */
  hidden: (): boolean => hidden,
  setVisible: (visible: boolean): void => {
    if (hidden === !visible) return;
    hidden = !visible;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  resetForTests: (): void => {
    hidden = false;
    listeners.clear();
  },
};

/** Server and first client render assume a visible page. */
export function useInstanceTabHidden(): boolean {
  return useSyncExternalStore(
    instanceTabVisibility.subscribe,
    instanceTabVisibility.hidden,
    () => false,
  );
}

/** The embedding page's origin: Chromium and WebKit list it, Firefox keeps the referrer. */
function embedderOrigin(target: Window): string | null {
  const ancestor = target.location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  try {
    return new URL(target.document.referrer).origin;
  } catch {
    return null;
  }
}

/**
 * Applies the host's visibility messages to this page and asks the host for
 * the current state. Does nothing outside an instance tab frame. Stopping
 * leaves the page visible.
 */
export function listenForInstanceTabVisibility(
  target: Window,
  ports: InstanceTabPortWindow | null = PORT_WINDOW,
): () => void {
  if (target.name !== INSTANCE_TAB_FRAME_NAME) return () => {};
  const onMessage = (event: MessageEvent) => {
    const visible = readInstanceTabVisibility(event, target, ports);
    if (visible !== null) instanceTabVisibility.setVisible(visible);
  };
  target.addEventListener("message", onMessage);
  const host = embedderOrigin(target);
  if (host !== null && isInstanceTabHostOrigin(host, ports)) {
    target.parent.postMessage({ type: INSTANCE_TAB_READY_MESSAGE }, host);
  }
  return () => {
    target.removeEventListener("message", onMessage);
    instanceTabVisibility.setVisible(true);
  };
}
