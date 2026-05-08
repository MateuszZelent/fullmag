#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_URL = "http://127.0.0.1:3001/workspace";
const DEFAULT_SECONDS = 120;
const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  "idle-performance-audit.json",
);

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    seconds: DEFAULT_SECONDS,
    out: DEFAULT_OUTPUT,
    chrome: process.env.FULLMAG_CHROME_BIN ?? null,
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i] ?? args.url;
    else if (arg === "--seconds") args.seconds = Number(argv[++i] ?? args.seconds);
    else if (arg === "--out") args.out = path.resolve(argv[++i] ?? args.out);
    else if (arg === "--chrome") args.chrome = argv[++i] ?? args.chrome;
    else if (arg === "--keep-open") args.keepOpen = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.seconds) || args.seconds <= 0) {
    throw new Error("--seconds must be a positive number");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-idle-performance.mjs [options]

Options:
  --url <url>          URL to profile. Default: ${DEFAULT_URL}
  --seconds <n>        Idle sample duration. Default: ${DEFAULT_SECONDS}
  --out <path>         JSON output path. Default: ${DEFAULT_OUTPUT}
  --chrome <path>      Chrome/Chromium binary. Also accepts FULLMAG_CHROME_BIN.
  --keep-open          Do not terminate the launched browser.
`);
}

async function findChrome(explicit) {
  if (explicit) return explicit;
  const candidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith("/")) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const found = await which(candidate);
    if (found) return found;
  }
  throw new Error(
    "Chrome/Chromium not found. Pass --chrome or set FULLMAG_CHROME_BIN.",
  );
}

async function which(name) {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of paths) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function launchChrome(chrome, url) {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "fullmag-idle-audit-"),
  );
  const port = 9222 + Math.floor(Math.random() * 1000);
  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    url,
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/error|failed/i.test(text)) {
      process.stderr.write(text);
    }
  });
  await waitForDevTools(port);
  return { child, port, userDataDir };
}

async function waitForDevTools(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint");
}

async function getPageWebSocket(port, targetUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    const pages = await response.json();
    const page = pages.find(
      (entry) => entry.type === "page" && entry.url.startsWith(targetUrl),
    ) ?? pages.find((entry) => entry.type === "page");
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await delay(250);
  }
  throw new Error("No debuggable page target found");
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message ?? "CDP command failed"));
    } else {
      request.resolve(message.result);
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    }),
    call(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ??
        result.exceptionDetails.exception?.description ??
        "Runtime evaluation failed",
    );
  }
  return result.result.value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPageReady(client) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const readyState = await evaluate(client, "document.readyState", false).catch(
      () => "loading",
    );
    if (readyState === "complete" || readyState === "interactive") {
      await delay(3000);
      return;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for page readiness");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = await findChrome(args.chrome);
  const launched = await launchChrome(chrome, args.url);
  try {
    const wsUrl = await getPageWebSocket(launched.port, args.url);
    const client = createCdpClient(wsUrl);
    await client.ready;
    await client.call("Runtime.enable");
    await client.call("Page.enable");
    await client.call("Page.navigate", { url: args.url });
    await waitForPageReady(client);
    const result = await evaluate(
      client,
      `window.__FULLMAG_AUDIT__?.snapshotDelta ? window.__FULLMAG_AUDIT__.snapshotDelta(${args.seconds}) : Promise.resolve({ error: "__FULLMAG_AUDIT__ unavailable" })`,
      true,
    );
    const payload = {
      url: args.url,
      seconds: args.seconds,
      capturedAt: new Date().toISOString(),
      result,
    };
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Wrote ${args.out}`);
    client.close();
  } finally {
    if (!args.keepOpen) {
      launched.child.kill("SIGTERM");
      await fs.rm(launched.userDataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
