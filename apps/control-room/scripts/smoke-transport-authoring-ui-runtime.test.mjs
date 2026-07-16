import assert from "node:assert/strict";
import { test } from "vitest";

import {
  connectCdpSocket,
  removeProfileDirectory,
  runTransportAuthoringSmoke,
  startChromium,
} from "./smoke-transport-authoring-ui-runtime.mjs";

class FakeWebSocket extends EventTarget {
  constructor({ closeOnRequest = true, readyState = 0 } = {}) {
    super();
    this.closeCalls = 0;
    this.closeOnRequest = closeOnRequest;
    this.readyState = readyState;
    this.sent = [];
  }

  close() {
    this.closeCalls += 1;
    if (!this.closeOnRequest) {
      this.readyState = 2;
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  send(payload) {
    this.sent.push(payload);
  }
}

async function connectedClient(socket, options = {}) {
  const connecting = connectCdpSocket({
    closeTimeoutMs: 5,
    createWebSocket: () => socket,
    timeoutMs: 25,
    url: "ws://browser",
    ...options,
  });
  socket.readyState = 1;
  socket.dispatchEvent(new Event("open"));
  return connecting;
}

test("connectCdpSocket closes a partial socket after connection timeout", async () => {
  const socket = new FakeWebSocket();

  await assert.rejects(connectCdpSocket({
    closeTimeoutMs: 5,
    createWebSocket: () => socket,
    timeoutMs: 1,
    url: "ws://browser",
  }), /timed out/);

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.readyState, 3);
});

test("connectCdpSocket closes a partial socket after connection error", async () => {
  const socket = new FakeWebSocket();
  const connecting = connectCdpSocket({
    closeTimeoutMs: 5,
    createWebSocket: () => socket,
    timeoutMs: 25,
    url: "ws://browser",
  });
  socket.dispatchEvent(new Event("error"));

  await assert.rejects(connecting, /failed to connect/);
  assert.equal(socket.closeCalls, 1);
});

test("removeProfileDirectory retries a transient non-empty Chromium profile", async () => {
  const delays = [];
  let attempts = 0;

  await removeProfileDirectory("/tmp/profile", {
    remove: () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("profile still busy");
        error.code = "ENOTEMPTY";
        throw error;
      }
    },
    retryDelayMs: 5,
    wait: async (delayMs) => delays.push(delayMs),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 10]);
});

test("connected CDP rejects pending requests and cleanup continues from CLOSED", async () => {
  const events = [];
  const socket = new FakeWebSocket();
  const cdp = await connectedClient(socket);
  const pending = cdp.send("Runtime.evaluate");
  socket.readyState = 3;
  socket.dispatchEvent(new Event("close"));

  await assert.rejects(pending, /connection closed/);
  await assert.rejects(runTransportAuthoringSmoke({
    connectCdp: async () => cdp,
    removeProfile: () => events.push("profile:remove"),
    run: async () => { throw new Error("run failed"); },
    startChromium: async () => ({ process: {}, userDataDir: "/tmp/profile", wsUrl: "ws://browser" }),
    startFixtureServer: async () => ({ close: async () => events.push("server:close") }),
    stopChromium: async () => events.push("browser:stop"),
  }), /run failed/);
  assert.deepEqual(events, ["browser:stop", "profile:remove", "server:close"]);
});

test("connected CDP rejects pending requests on a socket error", async () => {
  const socket = new FakeWebSocket();
  const cdp = await connectedClient(socket);
  const pending = cdp.send("Runtime.evaluate");

  socket.dispatchEvent(new Event("error"));

  await assert.rejects(pending, /connection failed/);
  await cdp.close();
});

test("connected CDP bounds cleanup while the socket remains CLOSING", async () => {
  const socket = new FakeWebSocket({ closeOnRequest: false });
  const cdp = await connectedClient(socket, { closeTimeoutMs: 1 });
  socket.readyState = 2;

  await cdp.close();

  assert.equal(socket.closeCalls, 0);
});

test("runTransportAuthoringSmoke cleans partial acquisition in reverse order", async () => {
  const events = [];
  const server = {
    close: async () => events.push("server:close"),
  };
  const browser = {
    process: {},
    userDataDir: "/tmp/profile",
    wsUrl: "ws://browser",
  };

  await assert.rejects(
    runTransportAuthoringSmoke({
      connectCdp: async () => {
        events.push("cdp:connect");
        throw new Error("CDP unavailable");
      },
      removeProfile: () => events.push("profile:remove"),
      run: async () => events.push("run"),
      startChromium: async () => {
        events.push("browser:start");
        return browser;
      },
      startFixtureServer: async () => {
        events.push("server:start");
        return server;
      },
      stopChromium: async () => events.push("browser:stop"),
    }),
    /CDP unavailable/,
  );

  assert.deepEqual(events, [
    "server:start",
    "browser:start",
    "cdp:connect",
    "browser:stop",
    "profile:remove",
    "server:close",
  ]);
});

test("runTransportAuthoringSmoke closes every acquired handle after a run failure", async () => {
  const events = [];
  const cdp = { close: async () => events.push("cdp:close") };

  await assert.rejects(
    runTransportAuthoringSmoke({
      connectCdp: async () => cdp,
      removeProfile: () => events.push("profile:remove"),
      run: async () => {
        events.push("run");
        throw new Error("route failed");
      },
      startChromium: async () => ({
        process: {},
        userDataDir: "/tmp/profile",
        wsUrl: "ws://browser",
      }),
      startFixtureServer: async () => ({
        close: async () => events.push("server:close"),
      }),
      stopChromium: async () => events.push("browser:stop"),
    }),
    /route failed/,
  );

  assert.deepEqual(events, [
    "run",
    "cdp:close",
    "browser:stop",
    "profile:remove",
    "server:close",
  ]);
});

test("startChromium rolls back its process and profile when DevTools startup fails", async () => {
  const events = [];
  const child = {};

  await assert.rejects(
    startChromium({
      createProfile: () => {
        events.push("profile:create");
        return "/tmp/profile";
      },
      findExecutable: () => "/chromium",
      removeProfile: () => events.push("profile:remove"),
      spawnBrowser: () => {
        events.push("browser:spawn");
        return child;
      },
      stopChromium: async () => events.push("browser:stop"),
      waitForDevTools: async () => {
        events.push("devtools:wait");
        throw new Error("DevTools timeout");
      },
    }),
    /DevTools timeout/,
  );

  assert.deepEqual(events, [
    "profile:create",
    "browser:spawn",
    "devtools:wait",
    "browser:stop",
    "profile:remove",
  ]);
});
