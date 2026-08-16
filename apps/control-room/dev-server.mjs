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
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { resolve, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureControlRoomDependencies,
  resolvePnpmInvocation,
} from "./scripts/resolve-pnpm-invocation.mjs";

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
const browserHost = process.env.FULLMAG_WEB_PUBLIC_HOST ?? "localhost";
const browserOrigin = `http://${formatUrlHost(browserHost)}:${port}`;
const staticRootIdx = args.indexOf("--static-root");
const staticRoot =
  staticRootIdx >= 0
    ? (args[staticRootIdx + 1] ?? process.env.FULLMAG_STATIC_WEB_ROOT)
    : process.env.FULLMAG_STATIC_WEB_ROOT;

function formatUrlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

if (staticRoot) {
  startStaticServer(staticRoot);
} else {
  startDevServer();
}

function startDevServer() {
  process.stderr.write(`[control-room dev-server] starting on :${port}\n`);
  removeStaleNextDevLock();

  let pnpm;
  try {
    pnpm = resolvePnpmInvocation();
  } catch (error) {
    process.stderr.write(
      `[control-room dev-server] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  try {
    if (ensureControlRoomDependencies({ appDir, cwd: repoRoot, pnpm })) {
      process.stderr.write(
        "[control-room dev-server] installed missing frontend dependencies\n",
      );
    }
  } catch (error) {
    process.stderr.write(
      `[control-room dev-server] frontend dependency setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  const child = spawn(
    pnpm.command,
    [
      ...pnpm.argsPrefix,
      "--dir",
      appDir,
      "dev",
      "--hostname",
      hostname,
      "--port",
      port,
    ],
    {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      shell: pnpm.shell,
      env: {
        ...process.env,
        FULLMAG_API_PROXY_TARGET: apiTarget,
        FULLMAG_API_URL: apiTarget,
        FULLMAG_WEB_PUBLIC_HOST: browserHost,
        NEXT_PUBLIC_API_URL: browserOrigin,
        NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: browserOrigin,
        NEXT_PUBLIC_FULLMAG_API_URL: browserOrigin,
        NEXT_PUBLIC_RUNTIME_HTTP_BASE: browserOrigin,
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
      `[control-room dev-server] failed to spawn pnpm via ${pnpm.source}: ${err.message}\n`,
    );
    process.exit(1);
  });
}

function removeStaleNextDevLock() {
  const lockPath = join(appDir, ".next", "dev", "lock");
  if (!existsSync(lockPath)) {
    return;
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return;
  }

  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0 || processIsRunning(pid)) {
    return;
  }

  try {
    unlinkSync(lockPath);
    const lockPort = Number.isInteger(Number(lock.port))
      ? ` on :${Number(lock.port)}`
      : "";
    process.stderr.write(
      `[control-room dev-server] removed stale Next dev lock for pid ${pid}${lockPort}\n`,
    );
  } catch {
    // If the lock disappears concurrently, let Next handle the remaining state.
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  server.on("upgrade", proxyWebSocketUpgrade);
  server.listen(Number(port), hostname);
  process.on("SIGINT", () => server.close(() => process.exit(130)));
  process.on("SIGTERM", () => server.close(() => process.exit(143)));
}

function proxyWebSocketUpgrade(req, clientSocket, head) {
  const target = new URL(req.url ?? "/", apiTarget);
  const proxyRequest = request(target, {
    headers: { ...req.headers, host: target.host },
    method: req.method ?? "GET",
  });

  proxyRequest.on("upgrade", (response, proxySocket, proxyHead) => {
    writeRawResponseHead(clientSocket, response);
    if (head.length > 0) proxySocket.write(head);
    if (proxyHead.length > 0) clientSocket.write(proxyHead);
    proxySocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => proxySocket.destroy());
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  proxyRequest.on("response", (response) => {
    writeRawResponseHead(clientSocket, response);
    response.pipe(clientSocket);
  });
  proxyRequest.on("error", () => clientSocket.destroy());
  proxyRequest.end();
}

function writeRawResponseHead(socket, response) {
  const statusMessage = response.statusMessage
    ? ` ${response.statusMessage}`
    : "";
  socket.write(`HTTP/1.1 ${response.statusCode ?? 502}${statusMessage}\r\n`);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(
      `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`,
    );
  }
  socket.write("\r\n");
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
