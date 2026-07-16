import assert from "node:assert/strict";
import test from "node:test";

import {
  runTransportAuthoringSmoke,
  startChromium,
} from "./smoke-transport-authoring-ui-runtime.mjs";

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
