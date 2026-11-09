import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function freePort() {
  const server = http.createServer();
  await listen(server);
  const { port } = server.address();
  await close(server);
  return port;
}

async function getThroughProxy(proxyOrigin, path) {
  const origin = new URL(proxyOrigin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(origin.port), origin.hostname);
    let response = "";
    const timeout = setTimeout(() => socket.destroy(new Error("proxy response timed out")), 3_000);
    socket.once("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
    socket.once("end", () => { clearTimeout(timeout); resolve(response); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

test("HTTP proxy uses the configured inactivity timeout and forwards exactly once on timeout", async () => {
  const originalRequest = http.request;
  const forwardedOptions = [];
  const timeoutValues = [];
  const timeoutMs = 600_000;
  let resolveForwarded;
  let triggerTimeout;
  const forwardedReady = new Promise((resolve) => { resolveForwarded = resolve; });

  http.request = (options) => {
    forwardedOptions.push(options);
    const forwarded = new EventEmitter();
    forwarded.write = () => true;
    forwarded.end = () => {};
    forwarded.setTimeout = (value, callback) => {
      timeoutValues.push(value);
      triggerTimeout = callback;
      return forwarded;
    };
    forwarded.destroy = (error) => {
      if (error) forwarded.emit("error", error);
      return forwarded;
    };
    resolveForwarded();
    return forwarded;
  };
  syncBuiltinESMExports();

  let proxy;
  try {
    const { startBrowserQaLoopbackProxy } = await import("./browser-qa-loopback-proxy.mjs");
    const port = await freePort();
    proxy = await startBrowserQaLoopbackProxy(
      `http://127.0.0.1:${port}`,
      "http://frontend:8080",
      { requestTimeoutMs: timeoutMs },
    );

    const responsePromise = getThroughProxy(proxy.origin, "/slow-grid-build");
    const firstEvent = await Promise.race([
      forwardedReady.then(() => ({ kind: "forwarded" })),
      responsePromise.then(
        (response) => ({ kind: "response", response }),
        (error) => ({ kind: "error", error }),
      ),
    ]);
    assert.equal(firstEvent.kind, "forwarded", firstEvent.error?.message ?? "proxy responded before forwarding");
    assert.equal(typeof triggerTimeout, "function");
    triggerTimeout();

    const response = await responsePromise;
    assert.match(response, /^HTTP\/1\.1 502\b/);
    assert.deepEqual(timeoutValues, [timeoutMs]);
    assert.equal(forwardedOptions.length, 1);
    assert.equal(forwardedOptions[0].hostname, "frontend");
    assert.equal(forwardedOptions[0].port, 8080);
    assert.equal(forwardedOptions[0].path, "/slow-grid-build");
  } finally {
    if (proxy) await proxy.close();
    http.request = originalRequest;
    syncBuiltinESMExports();
  }
});

test("invalid HTTP proxy timeout is rejected before listening", async () => {
  const occupied = http.createServer();
  await listen(occupied);
  const { port } = occupied.address();
  try {
    const { startBrowserQaLoopbackProxy } = await import("./browser-qa-loopback-proxy.mjs");
    for (const requestTimeoutMs of [0, -1, 1.5, NaN, Infinity, 600_001]) {
      await assert.rejects(
        startBrowserQaLoopbackProxy(
          `http://127.0.0.1:${port}`,
          "http://frontend:8080",
          { requestTimeoutMs },
        ),
        /requestTimeoutMs/,
      );
    }
  } finally {
    await close(occupied);
  }
});
