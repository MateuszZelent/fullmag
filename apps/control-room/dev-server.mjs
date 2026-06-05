#!/usr/bin/env node
/**
 * dev-server.mjs for apps/control-room
 *
 * Used by the fullmag binary when browser_control_room_assets points to
 * apps/control-room (after the Rust source is updated and rebuilt).
 *
 * Invocation by binary:
 *   node dev-server.mjs --hostname 0.0.0.0 --port 3100 --api-target http://localhost:8081
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, "../..");
const args = process.argv.slice(2);

const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? (args[portIdx + 1] ?? "3100") : "3100";
const hostnameIdx = args.indexOf("--hostname");
const hostname =
  hostnameIdx >= 0 ? (args[hostnameIdx + 1] ?? "0.0.0.0") : "0.0.0.0";
const apiTargetIdx = args.indexOf("--api-target");
const apiTarget =
  apiTargetIdx >= 0
    ? (args[apiTargetIdx + 1] ?? "http://localhost:8081")
    : "http://localhost:8081";
const staticRootIdx = args.indexOf("--static-root");
const staticRoot =
  staticRootIdx >= 0
    ? (args[staticRootIdx + 1] ?? process.env.FULLMAG_STATIC_WEB_ROOT)
    : process.env.FULLMAG_STATIC_WEB_ROOT;

if (staticRoot) {
  startStaticServer(staticRoot);
} else {
  startDevServer();
}

function startDevServer() {
  process.stderr.write(`[control-room dev-server] starting on :${port}\n`);

  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    pnpmCmd,
    ["--dir", appDir, "dev", "--hostname", hostname, "--port", port],
    {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        FULLMAG_API_PROXY_TARGET: apiTarget,
        FULLMAG_API_URL: apiTarget,
        NEXT_PUBLIC_API_URL: apiTarget,
        NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: apiTarget,
        NEXT_PUBLIC_FULLMAG_API_URL: apiTarget,
        NEXT_PUBLIC_RUNTIME_HTTP_BASE: apiTarget,
      },
      stdio: "inherit",
    },
  );

  const signalExitCodes = {
    SIGINT: 130,
    SIGTERM: 143,
  };

  let shuttingDown = false;
  let childExited = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    }
    setTimeout(() => {
      if (!childExited) {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    }, 2000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  child.on("exit", (code, signal) => {
    childExited = true;
    if (signal) {
      process.exit(signalExitCodes[signal] ?? 1);
      return;
    }
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    process.stderr.write(
      `[control-room dev-server] failed to spawn pnpm: ${err.message}\n`,
    );
    process.exit(1);
  });
}

function startStaticServer(root) {
  const resolvedRoot = resolve(repoRoot, root);
  process.stderr.write(
    `[control-room static-server] serving ${resolvedRoot} on :${port}\n`,
  );
  const server = createServer((req, res) => {
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (requestUrl.pathname.startsWith("/v2/")) {
      proxyApiRequest(req, res, requestUrl);
      return;
    }
    serveStaticFile(resolvedRoot, requestUrl.pathname, res);
  });
  server.listen(Number(port), hostname);
  process.on("SIGINT", () => server.close(() => process.exit(130)));
  process.on("SIGTERM", () => server.close(() => process.exit(143)));
}

function proxyApiRequest(req, res, requestUrl) {
  const target = new URL(requestUrl.pathname + requestUrl.search, apiTarget);
  const init = {
    headers: proxyHeaders(req.headers),
    method: req.method,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  const proxy = fetch(target, init);
  proxy
    .then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        res.end();
        return;
      }
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    })
    .catch((error) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `API proxy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

function serveStaticFile(root, pathname, res) {
  const candidate = staticCandidate(root, pathname);
  if (!candidate) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": contentType(candidate) });
  createReadStream(candidate).pipe(res);
}

function staticCandidate(root, pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const direct = resolve(
    root,
    `.${decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`}`,
  );
  const candidates = [
    direct,
    join(direct, "index.html"),
    join(root, "workspace", "index.html"),
    join(root, "index.html"),
  ];
  return candidates.find((path) => {
    try {
      return (
        existsSync(path) &&
        statSync(path).isFile() &&
        pathIsInsideRoot(root, path)
      );
    } catch {
      return false;
    }
  });
}

function pathIsInsideRoot(root, path) {
  const pathRelativeToRoot = relative(root, path);
  return (
    pathRelativeToRoot === "" ||
    (!pathRelativeToRoot.startsWith("..") &&
      !pathRelativeToRoot.startsWith("/") &&
      !pathRelativeToRoot.startsWith("\\"))
  );
}

function proxyHeaders(headers) {
  const forwarded = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (
      value === undefined ||
      lowerKey === "connection" ||
      lowerKey === "content-length" ||
      lowerKey === "host" ||
      lowerKey === "transfer-encoding"
    ) {
      continue;
    }
    forwarded[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return forwarded;
}

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}
