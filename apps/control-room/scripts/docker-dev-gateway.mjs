// Keep same-origin API traffic independent of the Next development event loop.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import httpxy from "next/dist/compiled/httpxy/index.js";

const { ProxyServer } = httpxy;

// The synchronous Mesh command can wait for rendering, capture and acceptance.
const API_PROXY_TIMEOUT_MS = (30 + 90 + 1800) * 1000 + 250;

function isApiRequest(url) {
  return url === "/v2" || url.startsWith("/v2/") || url.startsWith("/v2?");
}

export function createDevGateway({ apiTarget, nextTarget }) {
  const proxy = new ProxyServer({});
  function options(request) {
    if (!isApiRequest(request.url)) return { target: nextTarget };
    return {
      target: apiTarget,
      changeOrigin: true,
      headers: { "x-forwarded-host": request.headers.host ?? "" },
    };
  }

  // Propagate disconnects even after httpxy finishes reading the client body.
  proxy.on("proxyReq", (upstream, _request, response) => {
    response.once("close", () => upstream.destroy());
  });
  proxy.on("proxyRes", (upstream, _request, response) => {
    if (response.destroyed) upstream.destroy();
    else response.once("close", () => upstream.destroy());
  });
  const server = createServer((request, response) => {
    const upstream = options(request);
    if (upstream.target === apiTarget) {
      upstream.proxyTimeout = API_PROXY_TIMEOUT_MS;
      response.setHeader("x-content-type-options", "nosniff");
    }
    proxy.web(request, response, upstream).catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy(error);
      else response.writeHead(502).end("Bad Gateway");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    proxy.ws(request, socket, options(request), head).catch(() => socket.destroy());
  });
  return server;
}

function startGateway([port, nextPort, apiTarget, nextCommand, ...nextArgs]) {
  const server = createDevGateway({ apiTarget, nextTarget: `http://127.0.0.1:${nextPort}` });
  server.once("error", (error) => {
    console.error("Control Room development gateway:", error.message);
    process.exit(1);
  });
  server.listen(Number(port), "0.0.0.0", () => {
    // The container supervisor owns the process group, including the Next child.
    const next = spawn(nextCommand, nextArgs, { stdio: "inherit" });
    next.once("error", (error) => {
      console.error("Control Room Next development server:", error.message);
      process.exit(1);
    });
    next.once("exit", (code) => process.exit(code ?? 1));
  });
}

if (import.meta.main) startGateway(process.argv.slice(2));
