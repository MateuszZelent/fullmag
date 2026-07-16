import { rmSync } from "node:fs";

const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;
const WEB_SOCKET_CLOSED = 3;

function waitForSocketClose(socket, timeoutMs) {
  if (socket.readyState === WEB_SOCKET_CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener?.("close", finish);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    socket.addEventListener("close", finish, { once: true });
    if (socket.readyState !== WEB_SOCKET_CLOSING) {
      try {
        socket.close();
      } catch {
        finish();
      }
    }
  });
}

function waitForSocketOpen(socket, timeoutMs) {
  if (socket.readyState === WEB_SOCKET_OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener?.("open", handleOpen);
      socket.removeEventListener?.("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("CDP WebSocket failed to connect."));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("CDP WebSocket timed out."));
    }, timeoutMs);
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
  });
}

export async function connectCdpSocket({
  closeTimeoutMs = 1_000,
  createWebSocket,
  timeoutMs = 5_000,
  url,
}) {
  const socket = createWebSocket(url);
  try {
    await waitForSocketOpen(socket, timeoutMs);
  } catch (error) {
    await waitForSocketClose(socket, closeTimeoutMs);
    throw error;
  }

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const rejectPending = (message) => {
    const error = new Error(message);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  socket.addEventListener("close", () => rejectPending("CDP connection closed."));
  socket.addEventListener("error", () => rejectPending("CDP connection failed."));
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    if (payload.id && pending.has(payload.id)) {
      const entry = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) entry.reject(new Error(payload.error.message));
      else entry.resolve(payload.result ?? {});
      return;
    }
    for (const handler of listeners.get(payload.method) ?? []) {
      handler(payload.params ?? {});
    }
  });

  return {
    close: async () => {
      rejectPending("CDP connection closed.");
      await waitForSocketClose(socket, closeTimeoutMs);
    },
    on: (method, handler) => {
      const handlers = listeners.get(method) ?? [];
      handlers.push(handler);
      listeners.set(method, handlers);
    },
    send: (method, params = {}, session = null) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
        try {
          socket.send(JSON.stringify(session
            ? { id, method, params, sessionId: session }
            : { id, method, params }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}

export async function runTransportAuthoringSmoke(deps) {
  let fixtureServer = null;
  let browser = null;
  let cdp = null;
  let result;
  let failure = null;

  try {
    fixtureServer = await deps.startFixtureServer();
    browser = await deps.startChromium();
    cdp = await deps.connectCdp(browser.wsUrl);
    result = await deps.run({ browser, cdp, fixtureServer });
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failure ??= error;
      }
    };

    if (cdp) await cleanup(() => cdp.close());
    if (browser) {
      await cleanup(() => deps.stopChromium(browser.process));
      await cleanup(() => deps.removeProfile(browser.userDataDir));
    }
    if (fixtureServer) await cleanup(() => fixtureServer.close());
  }

  if (failure) throw failure;
  return result;
}

export async function removeProfileDirectory(userDataDir, options = {}) {
  const maxAttempts = options.maxAttempts ?? 8;
  const remove = options.remove ?? ((path) => rmSync(path, {
    force: true,
    recursive: true,
  }));
  const retryDelayMs = options.retryDelayMs ?? 50;
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      remove(userDataDir);
      return;
    } catch (error) {
      const retryable = error?.code === "EBUSY"
        || error?.code === "ENOTEMPTY"
        || error?.code === "EPERM";
      if (!retryable || attempt === maxAttempts) throw error;
      await wait(retryDelayMs * attempt);
    }
  }
}

export async function startChromium(deps) {
  const userDataDir = deps.createProfile();
  let child = null;
  try {
    const executable = deps.findExecutable();
    child = deps.spawnBrowser(executable, userDataDir);
    const wsUrl = await deps.waitForDevTools(child);
    return { process: child, userDataDir, wsUrl };
  } catch (error) {
    if (child) await deps.stopChromium(child).catch(() => undefined);
    await deps.removeProfile(userDataDir);
    throw error;
  }
}
