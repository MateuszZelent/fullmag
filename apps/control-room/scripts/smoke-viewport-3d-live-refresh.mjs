/**
 * Smoke ciągłości live-refresh viewportu 3D — Faza 0 planu remediacji
 * (docs/audits/2026-09-13-live-refresh-remediation-masterplan.md).
 *
 * Scenariusz: aktywna symulacja, stała topologia i stała domena, kamera bez
 * ruchu. Zmienia się wyłącznie wartość pola. Skrypt próbkuje liczniki
 * viewportu przez zadane okno i rozstrzyga twarde bramki poprawności.
 *
 * Wymaga działającego backendu z aktywną sesją oraz Control Roomu pod
 * CONTROL_ROOM_URL. Bez nich kończy się kodem 2 (środowisko), nie 1 (regresja).
 *
 * Zmienne środowiskowe:
 *   CONTROL_ROOM_URL                        domyślnie http://localhost:3100/workspace
 *   CONTROL_ROOM_LIVE_REFRESH_WINDOW_MS     okno pomiaru, domyślnie 60000
 *   CONTROL_ROOM_LIVE_REFRESH_SAMPLE_MS     odstęp próbkowania, domyślnie 500
 *   CONTROL_ROOM_LIVE_REFRESH_WARMUP_TICKS  pomijane ticki startowe, domyślnie 4
 *   CONTROL_ROOM_LIVE_REFRESH_MIN_REVISIONS minimum rewizji, domyślnie 30
 *   CONTROL_ROOM_LIVE_REFRESH_ARTIFACT      ścieżka artefaktu JSON
 *   CONTROL_ROOM_LIVE_REFRESH_ALLOW_UNKNOWN 1 = brak licznika nie przerywa biegu
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { installViewportPerformanceProbe } from "./lib/viewport-performance-proof.mjs";
import {
  evaluateLiveRefreshGates,
  formatLiveRefreshReport,
  liveRefreshGatesOutcome,
  summarizeLiveRefreshTrace,
} from "./lib/live-refresh-trace.mjs";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const windowMs = numericEnv("CONTROL_ROOM_LIVE_REFRESH_WINDOW_MS", 60_000);
const sampleMs = numericEnv("CONTROL_ROOM_LIVE_REFRESH_SAMPLE_MS", 500);
const warmupTicks = numericEnv("CONTROL_ROOM_LIVE_REFRESH_WARMUP_TICKS", 4);
const minRevisions = numericEnv("CONTROL_ROOM_LIVE_REFRESH_MIN_REVISIONS", 30);
const artifactPath = path.resolve(
  process.env.CONTROL_ROOM_LIVE_REFRESH_ARTIFACT ??
    ".artifacts/viewport-3d-live-refresh/trace.json",
);
const allowUnknown = process.env.CONTROL_ROOM_LIVE_REFRESH_ALLOW_UNKNOWN === "1";

const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";

function numericEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error(
    "Live-refresh smoke requires Playwright or @playwright/test in the current environment.",
  );
  process.exit(2);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
// Bez tego `window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__` nie istnieje
// i probe nie zapisuje ani jednego licznika.
await installViewportPerformanceProbe(page);
const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(String(error?.message ?? error)));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

let exitCode = 0;
try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT_3D_CANVAS_SELECTOR, { timeout: 60_000 });

  const samples = [];
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    samples.push(await captureSample(page));
    await page.waitForTimeout(sampleMs);
  }
  samples.push(await captureSample(page));

  const summary = summarizeLiveRefreshTrace(samples, { warmupTicks });
  const gates = evaluateLiveRefreshGates(summary);
  const outcome = liveRefreshGatesOutcome(gates);

  console.log(formatLiveRefreshReport(summary, gates));

  if (summary.uniqueDisplayedRevisions < minRevisions) {
    console.error(
      `Przebieg zaobserwował ${summary.uniqueDisplayedRevisions} odrębnych rewizji, ` +
        `wymagane minimum to ${minRevisions}. Solver prawdopodobnie nie publikował ` +
        "próbek — to nie jest wynik pomiaru, tylko brak scenariusza.",
    );
    exitCode = 2;
  } else if (outcome === "fail") {
    exitCode = 1;
  } else if (outcome === "unknown" && !allowUnknown) {
    console.error(
      "Część bramek ma status UNKNOWN — instrumentacja jest niekompletna. " +
        "Uzupełnij brakujące liczniki albo uruchom z CONTROL_ROOM_LIVE_REFRESH_ALLOW_UNKNOWN=1.",
    );
    exitCode = 1;
  }

  if (consoleErrors.length > 0) {
    console.error(`Błędy konsoli w trakcie przebiegu (${consoleErrors.length}):`);
    for (const message of consoleErrors.slice(0, 10)) console.error(`  ${message}`);
    exitCode = exitCode === 0 ? 1 : exitCode;
  }

  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify(
      { consoleErrors, gates, outcome, samples, summary, url },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Artefakt przebiegu: ${artifactPath}`);
} catch (error) {
  console.error(`Live-refresh smoke nie mógł wykonać scenariusza: ${String(error)}`);
  exitCode = 2;
} finally {
  await browser.close();
}

process.exit(exitCode);

async function captureSample(page) {
  return await page.evaluate(() => {
    const counters = window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ ?? {};
    const liveRefresh = window.__FULLMAG_VIEWPORT_3D_LIVE_REFRESH__ ?? null;
    return {
      atMs: performance.now(),
      counters,
      revisions: liveRefresh?.revisions ?? null,
    };
  });
}
