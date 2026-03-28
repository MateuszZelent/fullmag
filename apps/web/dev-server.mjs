import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

import next from "next";

function parseArgs(argv) {
  const args = {
    hostname: process.env.FULLMAG_WEB_BIND_HOST || "0.0.0.0",
    port: Number(process.env.PORT || process.env.FULLMAG_WEB_PORT || 3000),
    apiTarget: process.env.FULLMAG_API_PROXY_TARGET || "http://localhost:8080",
    staticRoot: process.env.FULLMAG_STATIC_WEB_ROOT || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];
    if (arg === "--hostname" && nextValue) {
      args.hostname = nextValue;
      index += 1;
    } else if (arg === "--port" && nextValue) {
      args.port = Number(nextValue);
      index += 1;
    } else if (arg === "--api-target" && nextValue) {
      args.apiTarget = nextValue;
      index += 1;
    } else if (arg === "--static-root" && nextValue) {
      args.staticRoot = nextValue;
      index += 1;
    }
  }

  return args;
}

function shouldProxyHttp(pathname) {
  return pathname === "/healthz" || pathname.startsWith("/v1/");
}

function shouldProxyWs(pathname) {
  return pathname.startsWith("/ws/live/");
}

function requestPathname(req) {
  const originHost = req.headers.host || "localhost";
  return new URL(req.url || "/", `http://${originHost}`).pathname;
}

function writeHttpError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = 502;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: `API proxy error: ${error.message}` }));
}

function proxyHttpRequest(req, res, apiUrl) {
  const upstream = http.request(
    {
      protocol: apiUrl.protocol,
      hostname: apiUrl.hostname,
      port: apiUrl.port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: apiUrl.host,
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => writeHttpError(res, error));
  req.pipe(upstream);
}

function proxyWsUpgrade(req, socket, head, apiUrl) {
  const upstream = net.connect(Number(apiUrl.port || 80), apiUrl.hostname, () => {
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .flatMap(([name, value]) => {
        if (name.toLowerCase() === "host") return [];
        if (value == null) return [];
        if (Array.isArray(value)) {
          return value.map((entry) => `${name}: ${entry}\r\n`);
        }
        return [`${name}: ${value}\r\n`];
      })
      .join("");

    upstream.write(requestLine);
    upstream.write(headers);
    upstream.write(`host: ${apiUrl.host}\r\n`);
    upstream.write("\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }

    socket.pipe(upstream).pipe(socket);
  });

  const closeSockets = () => {
    if (!socket.destroyed) socket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };

  upstream.on("error", closeSockets);
  socket.on("error", closeSockets);
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".map":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

async function readableFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

async function resolveStaticAsset(staticRoot, pathname) {
  const root = path.resolve(staticRoot);
  const decodedPath = decodeURIComponent(pathname || "/");
  const absolutePath = path.resolve(root, `.${decodedPath}`);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  const directStats = await readableFile(absolutePath);
  if (directStats) {
    return { filePath: absolutePath, statusCode: 200, stats: directStats };
  }

  const indexPath = path.join(absolutePath, "index.html");
  const indexStats = await readableFile(indexPath);
  if (indexStats) {
    return { filePath: indexPath, statusCode: 200, stats: indexStats };
  }

  if (!path.extname(absolutePath)) {
    const htmlPath = `${absolutePath}.html`;
    const htmlStats = await readableFile(htmlPath);
    if (htmlStats) {
      return { filePath: htmlPath, statusCode: 200, stats: htmlStats };
    }
  }

  const notFoundPath = path.join(root, "404.html");
  const notFoundStats = await readableFile(notFoundPath);
  if (notFoundStats) {
    return { filePath: notFoundPath, statusCode: 404, stats: notFoundStats };
  }

  return null;
}

async function serveStaticRequest(req, res, staticRoot) {
  const pathname = requestPathname(req);
  const asset = await resolveStaticAsset(staticRoot, pathname);
  if (!asset) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: `Static asset not found: ${pathname}` }));
    return;
  }

  res.statusCode = asset.statusCode;
  res.setHeader("content-type", contentTypeFor(asset.filePath));
  res.setHeader("content-length", asset.stats.size);
  res.setHeader("cache-control", "no-store");

  const stream = fs.createReadStream(asset.filePath);
  stream.on("error", (error) => writeHttpError(res, error));
  stream.pipe(res);
}

async function main() {
  const { hostname, port, apiTarget, staticRoot } = parseArgs(process.argv.slice(2));
  const apiUrl = new URL(apiTarget);
  const resolvedStaticRoot = staticRoot ? path.resolve(staticRoot) : null;
  const useStaticServer = Boolean(resolvedStaticRoot);
  const dev = !useStaticServer && process.env.NODE_ENV !== "production";

  let handle = null;
  let handleUpgrade = null;
  if (!useStaticServer) {
    const app = next({
      dev,
      dir: process.cwd(),
      hostname,
      port,
    });
    await app.prepare();
    handle = app.getRequestHandler();
    handleUpgrade = app.getUpgradeHandler();
  }

  const server = http.createServer((req, res) => {
    const pathname = requestPathname(req);

    if (shouldProxyHttp(pathname)) {
      proxyHttpRequest(req, res, apiUrl);
      return;
    }

    if (useStaticServer && resolvedStaticRoot) {
      serveStaticRequest(req, res, resolvedStaticRoot).catch((error) =>
        writeHttpError(res, error),
      );
      return;
    }

    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = requestPathname(req);
    if (shouldProxyWs(pathname)) {
      proxyWsUpgrade(req, socket, head, apiUrl);
      return;
    }
    if (handleUpgrade) {
      handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(
      useStaticServer
        ? `fullmag static control room ready on http://${hostname}:${port} (api proxy ${apiUrl.origin}, static root ${resolvedStaticRoot})`
        : `fullmag control room ready on http://${hostname}:${port} (api proxy ${apiUrl.origin})`,
    );
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
