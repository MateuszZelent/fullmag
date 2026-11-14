import { createServer, request } from "node:http";

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_HTTP_REQUEST_TIMEOUT_MS = 600_000;

/** Give the isolated browser its normal loopback origin through one fixed service. */
export async function startBrowserQaLoopbackProxy(publicUrl, upstreamUrl, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Browser QA proxy options must be an object");
  }
  const requestTimeoutMs = options.requestTimeoutMs === undefined
    ? DEFAULT_HTTP_REQUEST_TIMEOUT_MS
    : options.requestTimeoutMs;
  if (typeof requestTimeoutMs !== "number" || !Number.isFinite(requestTimeoutMs) ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_HTTP_REQUEST_TIMEOUT_MS) {
    throw new Error("Browser QA proxy requestTimeoutMs must be a finite positive integer no greater than 600000");
  }
  const origin = new URL(publicUrl);
  const upstream = new URL(upstreamUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port ||
      origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password ||
      upstream.protocol !== "http:" || upstream.hostname !== "frontend" || upstream.port !== "8080" ||
      upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) {
    throw new Error("Browser QA proxy requires the selected loopback origin and fixed private frontend service");
  }
  const sockets = new Set();
  const failures = [];
  let closing = false;
  const valid = (req) => req.headers.host === origin.host &&
    typeof req.url === "string" && req.url.startsWith("/") && !req.url.startsWith("//");
  const targetRequest = (req) => request({
    hostname: upstream.hostname,
    port: Number(upstream.port),
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: origin.host },
  });
  const recordFailure = (error) => {
    if (failures.length < 16) failures.push(String(error?.message ?? error).slice(0, 512));
  };
  const server = createServer((req, res) => {
    if (!valid(req)) { res.writeHead(400); res.end(); return; }
    const forwarded = targetRequest(req);
    let clientCancelled = false;
    const cancelForward = () => { clientCancelled = true; forwarded.destroy(); };
    // ClientRequest.setTimeout is an inactivity timeout, not a total request deadline.
    forwarded.setTimeout(requestTimeoutMs, () => forwarded.destroy(new Error("QA frontend proxy timed out")));
    forwarded.on("response", (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", (error) => {
        if (!clientCancelled && !closing) recordFailure(error);
        res.destroy(error);
      });
      response.pipe(res);
    });
    forwarded.on("error", (error) => {
      if (!clientCancelled && !closing) recordFailure(error);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", cancelForward);
    req.on("error", cancelForward);
    res.on("close", () => { if (!res.writableFinished) cancelForward(); });
    req.pipe(forwarded);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, clientSocket, head) => {
    if (!valid(req)) { clientSocket.destroy(); return; }
    const forwarded = targetRequest(req);
    let tunnelSocket = null;
    let clientCancelled = false;
    const closePendingTunnel = () => {
      clientCancelled = true;
      forwarded.destroy();
      tunnelSocket?.destroy();
    };
    clientSocket.on("error", closePendingTunnel);
    clientSocket.on("close", closePendingTunnel);
    forwarded.setTimeout(10_000, () => forwarded.destroy(new Error("QA WebSocket upgrade timed out")));
    forwarded.on("upgrade", (response, proxySocket, proxyHead) => {
      forwarded.setTimeout(0);
      tunnelSocket = proxySocket;
      if (clientSocket.destroyed) { proxySocket.destroy(); return; }
      sockets.add(proxySocket);
      proxySocket.on("close", () => sockets.delete(proxySocket));
      clientSocket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}\r\n`);
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        clientSocket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
      }
      clientSocket.write("\r\n");
      if (head.length) proxySocket.write(head);
      if (proxyHead.length) clientSocket.write(proxyHead);
      proxySocket.on("error", (error) => {
        if (!clientCancelled && !closing) recordFailure(error);
        clientSocket.destroy();
      });
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });
    forwarded.on("response", (response) => {
      recordFailure(new Error(`QA WebSocket upgrade returned HTTP ${response.statusCode}`));
      response.resume();
      clientSocket.destroy();
    });
    forwarded.on("error", (error) => {
      if (!clientCancelled && !closing) recordFailure(error);
      clientSocket.destroy();
    });
    forwarded.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(origin.port), origin.hostname, resolve);
  });
  return {
    origin: origin.origin,
    upstream: upstream.origin,
    failures,
    close: () => new Promise((resolve, reject) => {
      closing = true;
      server.close((error) => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    }),
  };
}
