import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { open, lstat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";

const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json");
const expectedPlaywright = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION ?? "1.62.1";
const protocol = "fullmag.docker-dev-hmr-protocol.v1";
const protocolSchema = process.env.CONTROL_ROOM_HMR_PROTOCOL ?? "";
const resultSchema = "fullmag.docker-dev-hmr-qa-result.v1";
const attempt = process.env.CONTROL_ROOM_HMR_ATTEMPT ?? "";
const routePath = process.env.CONTROL_ROOM_HMR_ROUTE_PATH ?? "";
const controlRoot = "/control";
const propertyName = "--fm-docker-hmr-probe";
const timeout = Math.min(Number.parseInt(process.env.CONTROL_ROOM_HMR_TIMEOUT_MS ?? "120000", 10), 300_000);
const maxBytes = Math.min(Number.parseInt(process.env.CONTROL_ROOM_HMR_MAX_BYTES ?? "262144", 10), 262_144);
const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL ?? "";
const privateUrl = process.env.CONTROL_ROOM_URL ?? "http://frontend:8080";
const runnerSourcePath = fileURLToPath(import.meta.url);
const proxySourcePath = fileURLToPath(new URL("./lib/browser-qa-loopback-proxy.mjs", import.meta.url));
const bounded = (value) => String(value).slice(0, 2048);
const diagnosticText = (value) => String(value ?? "").slice(0, 1024);
const diagnosticLimit = 32;
const filePath = (name) => join(controlRoot, name);

const validAttempt = /^[0-9a-f]{32}$/.test(attempt);
const validRoute = /^\/fullmag-hmr-probe-[a-z0-9][a-z0-9-]{7,63}$/.test(routePath);
const routeName = validRoute ? routePath.slice(1) : "";
const probeSelector = validRoute ? `[data-fullmag-hmr-probe="${routeName}"]` : "";
const clientReadySelector = validRoute ? `${probeSelector}[data-fullmag-hmr-client="ready"]` : "";
const validNonce = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{7,63}$/.test(value);
const validSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const createDiagnostics = () => ({
  console: [],
  pageerrors: [],
  api: [],
  document_requests: [],
  frame_events: [],
  hmr: {
    connected: false,
    synced: false,
    building: false,
    closed: false,
    intentional_close: false,
    url: null,
    frames: [],
    builds: [],
    errors: [],
    failure: null,
  },
});
const appendDiagnostic = (items, value) => {
  if (items.length < diagnosticLimit) items.push(value);
};
const diagnosticsSnapshot = (diagnostics) => JSON.parse(JSON.stringify(diagnostics));

const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const readHarnessSourceHashes = async () => ({
  runner: await sha256File(runnerSourcePath),
  loopback_proxy: await sha256File(proxySourcePath),
});
const sameHarnessSourceHashes = (left, right) => (
  left && right && validSha256(left.runner) && validSha256(left.loopback_proxy)
    && left.runner === right.runner && left.loopback_proxy === right.loopback_proxy
);
const parseExpectedHarnessSourceHashes = () => {
  let value;
  try {
    value = JSON.parse(process.env.CONTROL_ROOM_HMR_HARNESS_SOURCE_SHA256 ?? "");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "algorithm,loopback_proxy,runner"
      || value.algorithm !== "sha256" || !validSha256(value.runner) || !validSha256(value.loopback_proxy)) {
    return null;
  }
  return { runner: value.runner, loopback_proxy: value.loopback_proxy };
};
const expectedHarnessSourceHashes = parseExpectedHarnessSourceHashes();
const harnessSourceEvidence = (before, after) => ({
  algorithm: "sha256",
  runner_before: before.runner,
  runner_after: after.runner,
  loopback_proxy_before: before.loopback_proxy,
  loopback_proxy_after: after.loopback_proxy,
  unchanged: sameHarnessSourceHashes(before, after),
});

const readControlJson = async (name) => {
  const path = filePath(name);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxBytes) {
    throw new Error(`control protocol record is not a bounded regular file: ${name}`);
  }
  const raw = await readFile(path);
  if (raw.length > maxBytes) throw new Error(`control protocol record exceeds its byte budget: ${name}`);
  const value = JSON.parse(raw.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`control protocol record is not an object: ${name}`);
  }
  return value;
};

const writeControlJson = async (name, value) => {
  const target = filePath(name);
  const temporary = filePath(`.hmr-${name}-${attempt}.tmp`);
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.length > maxBytes) throw new Error(`control protocol output exceeds its byte budget: ${name}`);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      throw new Error(`control protocol target is not a regular file: ${name}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForCommand = async (state, nonce, sourceSha256) => {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    const command = await readControlJson("command.json");
    if (command) {
      if (command.schema !== protocol || command.attempt !== attempt || !validNonce(command.nonce)) {
        throw new Error("HMR command identity or nonce is invalid");
      }
      const fingerprint = JSON.stringify(command);
      if (fingerprint !== last) {
        last = fingerprint;
        if (command.state === "abort") throw new Error("HMR operation was aborted by its managed caller");
        if (command.state === state && (nonce === undefined || command.nonce === nonce) &&
            (sourceSha256 === undefined || command.source_sha256 === sourceSha256)) return command;
      }
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for HMR command ${state}`);
};

const sessionIdentity = async (page, diagnostics) => {
  const endpoint = new URL("/v2/sessions/current/status", page.url()).toString();
  const response = await page.request.get(endpoint, { timeout });
  let rawBody;
  try {
    rawBody = await response.body();
  } catch (error) {
    appendDiagnostic(diagnostics.api, {
      status: response.status(),
      error: diagnosticText(error?.message ?? error),
    });
    throw new Error(`GET /v2/sessions/current/status body could not be read: ${diagnosticText(error?.message ?? error)}`);
  }
  const bodyText = rawBody.subarray(0, 4096).toString("utf8");
  if (response.status() !== 200) {
    appendDiagnostic(diagnostics.api, { status: response.status(), body: bodyText.slice(0, 1024) });
    throw new Error(`GET /v2/sessions/current/status returned ${response.status()}`);
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    appendDiagnostic(diagnostics.api, {
      status: response.status(),
      error: diagnosticText(error?.message ?? error),
      body: bodyText.slice(0, 1024),
    });
    throw new Error(`GET /v2/sessions/current/status returned invalid JSON: ${diagnosticText(error?.message ?? error)}; body=${bodyText.slice(0, 1024)}`);
  }
  const session = body?.session;
  if (body?.lifecycle?.session_resource !== "active") throw new Error("current session resource is not active");
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    if (typeof session?.[key] !== "string" || session[key].trim() === "") {
      throw new Error(`current session identity omitted ${key}`);
    }
  }
  return {
    session_id: session.session_id,
    session_epoch: session.session_epoch,
    request_scope_epoch: session.request_scope_epoch,
  };
};

const probeElement = async (page) => {
  const marker = page.locator(probeSelector);
  await marker.waitFor({ state: "visible", timeout });
  await page.locator(clientReadySelector).waitFor({ state: "visible", timeout });
  const handle = await marker.elementHandle();
  if (!handle) throw new Error("HMR route marker did not yield an element handle");
  return handle;
};

const installPageDiagnostics = (page, diagnostics, getNavigationCount) => {
  const waiters = [];
  const rejectWaiters = (error) => {
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const resolveWaiters = () => {
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };
  const checkHmrReady = () => {
    if (diagnostics.hmr.failure) {
      rejectWaiters(new Error(`HMR websocket failed before helper-ready: ${diagnostics.hmr.failure}`));
    } else if (diagnostics.hmr.closed) {
      rejectWaiters(new Error("HMR websocket closed before helper-ready"));
    } else if (diagnostics.hmr.synced && !diagnostics.hmr.building && getNavigationCount() === 0) {
      resolveWaiters();
    }
  };
  const markHmrFailure = (message) => {
    if (!diagnostics.hmr.failure) diagnostics.hmr.failure = diagnosticText(message);
    checkHmrReady();
  };
  page.on("console", (message) => {
    appendDiagnostic(diagnostics.console, {
      type: message.type(),
      text: diagnosticText(message.text()),
    });
  });
  page.on("pageerror", (error) => {
    appendDiagnostic(diagnostics.pageerrors, { error: diagnosticText(error?.stack ?? error?.message ?? error) });
  });
  page.on("websocket", (websocket) => {
    if (new URL(websocket.url()).pathname !== "/_next/hmr") return;
    diagnostics.hmr.connected = true;
    diagnostics.hmr.url = diagnosticText(websocket.url());
    websocket.on("framereceived", (frame) => {
      const payload = frame?.payload ?? frame;
      const raw = diagnosticText(typeof payload === "string" ? payload : payload?.toString?.() ?? payload);
      let parsed;
      try {
        parsed = JSON.parse(typeof payload === "string" ? payload : payload?.toString?.() ?? "");
      } catch {
        parsed = null;
      }
      const action = typeof parsed?.type === "string"
        ? parsed.type
        : typeof parsed?.action === "string" ? parsed.action : "non-json";
      const normalizedAction = action.toLowerCase();
      const wasSynced = diagnostics.hmr.synced;
      appendDiagnostic(diagnostics.hmr.frames, { action, message: raw });
      if (normalizedAction === "sync") diagnostics.hmr.synced = true;
      if (normalizedAction === "building") diagnostics.hmr.building = true;
      if (normalizedAction === "built" || normalizedAction === "sync") diagnostics.hmr.building = false;
      if (["building", "built", "ok", "still-ok", "hash"].includes(normalizedAction)
          || normalizedAction.includes("build")) {
        appendDiagnostic(diagnostics.hmr.builds, { action, message: raw });
      }
      const hasErrors = normalizedAction.includes("error")
        || (Array.isArray(parsed?.errors) && parsed.errors.length > 0);
      if (normalizedAction === "reloadpage") {
        appendDiagnostic(diagnostics.hmr.errors, { action, message: raw });
        markHmrFailure(`${action}: ${raw}`);
      }
      if (hasErrors) {
        appendDiagnostic(diagnostics.hmr.errors, { action, message: raw });
        if (!wasSynced || normalizedAction === "sync") markHmrFailure(`${action}: ${raw}`);
      }
      checkHmrReady();
    });
    websocket.on("socketerror", (error) => {
      const message = diagnosticText(error?.message ?? error);
      appendDiagnostic(diagnostics.hmr.errors, { action: "socketerror", message });
      markHmrFailure(`socketerror: ${message}`);
    });
    websocket.on("close", () => {
      diagnostics.hmr.closed = true;
      if (!diagnostics.hmr.synced) markHmrFailure("websocket closed before sync");
      checkHmrReady();
    });
  });
  return {
    waitForHmrConnection: () => {
      if (diagnostics.hmr.failure) {
        return Promise.reject(new Error(`HMR websocket failed before helper-ready: ${diagnostics.hmr.failure}`));
      }
      if (diagnostics.hmr.closed) return Promise.reject(new Error("HMR websocket closed before helper-ready"));
      if (diagnostics.hmr.synced && !diagnostics.hmr.building && getNavigationCount() === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("HMR websocket did not reach sync before helper-ready"));
        }, timeout);
        waiters.push({ resolve, reject, timer });
        checkHmrReady();
      });
    },
  };
};

const domIdentity = async (handle) => handle.evaluate((element, selector) => {
  const canonical = document.querySelector(selector);
  return {
    tag_name: element.tagName,
    attribute: element.getAttribute("data-fullmag-hmr-probe"),
    class_name: element.className,
    connected: element.isConnected,
    same_element: element === canonical,
  };
}, probeSelector);

const documentToken = async (page) => page.evaluate(() => {
  const key = "__fullmag_hmr_document_token";
  if (!window[key]) window[key] = crypto.randomUUID();
  return window[key];
});

const readProperty = async (handle) => handle.evaluate((element, name) => (
  getComputedStyle(element).getPropertyValue(name).trim()
), propertyName);

const stableIdentity = async (page, baseline, getNavigationCount, diagnostics) => {
  const current = {
    session: await sessionIdentity(page, diagnostics),
    dom: await domIdentity(baseline.dom_handle),
    document_token: await documentToken(page),
  };
  if (new URL(page.url()).pathname !== routePath || getNavigationCount() !== 0) {
    throw new Error("HMR proof route navigated after baseline");
  }
  for (const key of ["session", "dom", "document_token"]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(baseline[key])) {
      throw new Error(`HMR proof changed ${key} identity`);
    }
  }
  if (current.dom.connected !== true || current.dom.same_element !== true) {
    throw new Error("HMR proof replaced or detached the retained probe DOM element");
  }
  return current;
};

const assertHealthyHmr = (diagnostics) => {
  if (diagnostics.hmr.failure || (diagnostics.hmr.closed && !diagnostics.hmr.intentional_close)
      || diagnostics.hmr.errors.length || diagnostics.pageerrors.length) {
    throw new Error("HMR reported a browser or compiler failure during the CSS transition");
  }
};

// A computed property can change before the replacement stylesheet's load
// handler finishes. Wait for those handlers and a browser rendering turn so
// a late CSS cleanup exception cannot be published as a successful proof.
const settleStylesheets = async (page, diagnostics) => {
  await page.waitForFunction(
    () => [...document.querySelectorAll('link[rel="stylesheet"]')].every((link) => link.isLoaded !== false),
    null,
    { timeout },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assertHealthyHmr(diagnostics);
};

const waitForProperty = async (page, baseline, expected, getNavigationCount, diagnostics) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assertHealthyHmr(diagnostics);
    const value = await readProperty(baseline.dom_handle);
    if (value === expected) {
      await settleStylesheets(page, diagnostics);
      const identity = await stableIdentity(page, baseline, getNavigationCount, diagnostics);
      assertHealthyHmr(diagnostics);
      return { value, identity };
    }
    await sleep(100);
  }
  throw new Error(`CSS custom property did not become ${expected}`);
};

const gotoProbe = async (page, origin) => {
  const target = new URL(routePath, origin).toString();
  const deadline = Date.now() + timeout;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 15_000) });
      lastStatus = response?.status() ?? "no response";
      if (response && response.status() < 400) return;
    } catch (error) {
      lastStatus = bounded(error?.message ?? error);
    }
    await sleep(250);
  }
  throw new Error(`Fullmag HMR route did not become ready (last status ${lastStatus})`);
};

const main = async () => {
  let sourceHashesBefore = null;
  let loopbackProxy = null;
  let browser = null;
  let page = null;
  let navigationCount = 0;
  let terminalWritten = false;
  let nonce = null;
  const diagnostics = createDiagnostics();
  try {
    if (!validAttempt || protocolSchema !== protocol || !validRoute || !expectedHarnessSourceHashes) {
      throw new Error("HMR helper protocol/route/harness admission is invalid");
    }
    if (!publicUrl || playwrightPackage.version !== expectedPlaywright || expectedPlaywright !== "1.62.1") {
      throw new Error("HMR helper browser/proxy admission is invalid");
    }
    sourceHashesBefore = await readHarnessSourceHashes();
    if (!sameHarnessSourceHashes(sourceHashesBefore, expectedHarnessSourceHashes)) {
      throw new Error("HMR helper source hashes differ before browser launch");
    }
    loopbackProxy = await startBrowserQaLoopbackProxy(publicUrl, privateUrl);
    browser = await chromium.launch({
      headless: true,
      args: [
        "--headless=new",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--no-sandbox",
        "--use-angle=swiftshader-webgl",
        "--use-gl=angle",
      ],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // App Router may update browser history during an RSC refresh. Count
    // actual document requests; retained DOM/document tokens independently
    // reject reloads or replacements without a network request.
    page.on("request", (request) => {
      if (!request.isNavigationRequest()) return;
      try {
        if (request.frame() !== page.mainFrame()) return;
      } catch {
        // An unbound navigation is still a reason to reject this proof.
      }
      navigationCount += 1;
      appendDiagnostic(diagnostics.document_requests, { url: diagnosticText(request.url()) });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) appendDiagnostic(diagnostics.frame_events, { url: diagnosticText(frame.url()) });
    });
    const hmrReadiness = installPageDiagnostics(page, diagnostics, () => navigationCount);
    await gotoProbe(page, loopbackProxy.origin);
    if (new URL(page.url()).pathname !== routePath) throw new Error(`Expected ${routePath}, got ${page.url()}`);
    await probeElement(page);
    navigationCount = 0;
    await hmrReadiness.waitForHmrConnection();
    if (navigationCount !== 0) throw new Error("HMR proof route navigated before helper-ready");
    const domHandle = await probeElement(page);
    const baseline = {
      page_url: page.url(),
      session: await sessionIdentity(page, diagnostics),
      dom: await domIdentity(domHandle),
      dom_handle: domHandle,
      document_token: await documentToken(page),
    };
    if (await readProperty(domHandle) !== "") throw new Error("HMR probe property already exists before the candidate");
    await writeControlJson("helper-ready.json", {
      schema: protocol,
      state: "ready",
      attempt,
      route_path: routePath,
      property: "",
      navigation_count: navigationCount,
      session: baseline.session,
      dom: baseline.dom,
      document_token: baseline.document_token,
      page_url: baseline.page_url,
      diagnostics: diagnosticsSnapshot(diagnostics),
      harness_source_sha256: {
        algorithm: "sha256",
        runner_before: sourceHashesBefore.runner,
        loopback_proxy_before: sourceHashesBefore.loopback_proxy,
      },
    });
    const candidateCommand = await waitForCommand("candidate", undefined, undefined);
    nonce = candidateCommand.nonce;
    if (!validNonce(nonce) || typeof candidateCommand.source_sha256 !== "string") throw new Error("candidate command payload is invalid");
    const candidate = await waitForProperty(page, baseline, `hmr-${nonce}`, () => navigationCount, diagnostics);
    await writeControlJson("helper-candidate.json", {
      schema: protocol,
      state: "candidate-verified",
      attempt,
      nonce,
      route_path: routePath,
      property: candidate.value,
      navigation_count: navigationCount,
      session: candidate.identity.session,
      dom: candidate.identity.dom,
      document_token: candidate.identity.document_token,
    });
    const restoreCommand = await waitForCommand("restore", nonce, undefined);
    if (typeof restoreCommand.source_sha256 !== "string") throw new Error("restore command payload is invalid");
    const restored = await waitForProperty(page, baseline, "", () => navigationCount, diagnostics);
    await writeControlJson("helper-restore.json", {
      schema: protocol,
      state: "restore-verified",
      attempt,
      nonce,
      route_path: routePath,
      property: restored.value,
      navigation_count: navigationCount,
      session: restored.identity.session,
      dom: restored.identity.dom,
      document_token: restored.identity.document_token,
    });
    const sourceHashesAfter = await readHarnessSourceHashes();
    const harnessEvidence = harnessSourceEvidence(sourceHashesBefore, sourceHashesAfter);
    if (!harnessEvidence.unchanged) throw new Error("HMR harness source changed before terminal publication");
    assertHealthyHmr(diagnostics);
    // Close the observed browser before taking the immutable terminal
    // snapshot. A websocket close caused by this deliberate shutdown is
    // recorded separately from an unexpected HMR disconnect.
    diagnostics.hmr.intentional_close = true;
    await browser.close();
    browser = null;
    await loopbackProxy.close();
    loopbackProxy = null;
    await new Promise((resolve) => setImmediate(resolve));
    const terminal = {
      schema: protocol,
      state: "succeeded",
      attempt,
      nonce,
      route_path: routePath,
      property: "",
      navigation_count: navigationCount,
      session: baseline.session,
      dom: baseline.dom,
      document_token: baseline.document_token,
      diagnostics: diagnosticsSnapshot(diagnostics),
      harness_source_sha256: harnessEvidence,
    };
    await writeControlJson("helper-terminal.json", terminal);
    terminalWritten = true;
    console.log(JSON.stringify({ schema: resultSchema, state: "succeeded", attempt, nonce, route_path: routePath }));
  } catch (error) {
    let failedHarnessEvidence;
    if (sourceHashesBefore) {
      try {
        failedHarnessEvidence = harnessSourceEvidence(sourceHashesBefore, await readHarnessSourceHashes());
      } catch {
        failedHarnessEvidence = undefined;
      }
    }
    if (!terminalWritten) {
      try {
        await writeControlJson("helper-terminal.json", {
          schema: protocol,
          state: "failed-confirmed",
          attempt,
          nonce: validNonce(nonce) ? nonce : undefined,
          route_path: routePath,
          navigation_count: navigationCount,
          error: bounded(error?.stack ?? error),
          diagnostics: diagnosticsSnapshot(diagnostics),
          ...(failedHarnessEvidence ? { harness_source_sha256: failedHarnessEvidence } : {}),
        });
        terminalWritten = true;
      } catch {
        // A missing durable record is intentionally an unknown outcome.
      }
    }
    console.log(JSON.stringify({ schema: resultSchema, state: "failed-confirmed", attempt, nonce, route_path: routePath, error: bounded(error?.message ?? error) }));
    process.exitCode = 2;
  } finally {
    await browser?.close();
    await loopbackProxy?.close();
  }
};

await main();
