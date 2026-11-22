import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createDevGateway } from "./docker-dev-gateway.mjs";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("same-origin API streams to the backend while Next is waiting on a page", async (t) => {
  const { promise: pageReceived, resolve: markPageReceived } = Promise.withResolvers();
  const { promise: pageReady, resolve: finishPage } = Promise.withResolvers();
  t.after(finishPage);
  const next = await listen(t, createServer(async (request, response) => {
    markPageReceived(request.url);
    await pageReady;
    response.end("Control Room");
  }));
  const backend = await listen(t, createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("x-observed-path", request.url);
    response.setHeader("x-observed-method", request.method);
    response.setHeader("x-observed-host", request.headers.host);
    response.setHeader("x-observed-forwarded-host", request.headers["x-forwarded-host"]);
    response.setHeader("x-observed-scope", request.headers["x-fullmag-session-scope"]);
    response.end(Buffer.concat(chunks));
  }));
  const gateway = await listen(t, createDevGateway({ apiTarget: backend, nextTarget: next }));

  const page = fetch(`${gateway}/session/working-session`, { signal: AbortSignal.timeout(4000) });
  assert.equal(await pageReceived, "/session/working-session");
  const payload = Uint8Array.of(0, 1, 128, 255);
  const resource = "/v2/sessions/current/example?q=%2F%2B";
  const response = await fetch(gateway + resource, {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/octet-stream",
      "x-forwarded-host": "untrusted.example",
      "x-fullmag-session-scope": "session=working-session",
    },
    signal: AbortSignal.timeout(1500),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("x-observed-path"), resource);
  assert.equal(response.headers.get("x-observed-method"), "POST");
  assert.equal(response.headers.get("x-observed-host"), new URL(backend).host);
  assert.equal(response.headers.get("x-observed-forwarded-host"), new URL(gateway).host);
  assert.equal(response.headers.get("x-observed-scope"), "session=working-session");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
  finishPage();
  assert.equal(await (await page).text(), "Control Room");
});

test("WebSocket upgrades reach the API and HMR upstreams separately", async (t) => {
  const received = [];
  function upstream(label) {
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      received.push([label, request.url, request.headers.host]);
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.end(Buffer.from([0x88, 0]));
    });
    return server;
  }

  const backend = await listen(t, upstream("API"));
  const next = await listen(t, upstream("Next"));
  const gateway = await listen(t, createDevGateway({ apiTarget: backend, nextTarget: next }));
  for (const path of ["/v2/sessions/current/events/ws", "/_next/webpack-hmr?token=hmr"]) {
    const ws = new WebSocket(gateway.replace("http:", "ws:") + path);
    await once(ws, "open");
    if (ws.readyState !== WebSocket.CLOSED) await once(ws, "close");
  }
  assert.deepEqual(received, [
    ["API", "/v2/sessions/current/events/ws", new URL(backend).host],
    ["Next", "/_next/webpack-hmr?token=hmr", new URL(gateway).host],
  ]);
});
