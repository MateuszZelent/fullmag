import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "file:///C:/git/fullmag/fullmag/apps/control-room/node_modules/playwright/index.mjs";
import { buildAllCaptureJobs } from "./docs-screenshots/captures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKTREE_ROOT = path.resolve(__dirname, "..", "..", "..");
const OUTPUT_DIR = path.join(WORKTREE_ROOT, "public_docs", "site", "_static", "images", "ui");

function parseArgs(argv) {
  let only = null;
  let list = false;
  for (const arg of argv) {
    if (arg.startsWith("--only=")) {
      only = arg.slice("--only=".length).trim().toLowerCase();
    } else if (arg === "--list") {
      list = true;
    }
  }
  return { only, list };
}

async function main() {
  const { only, list } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allJobs = buildAllCaptureJobs(OUTPUT_DIR);
  const onlyFilters = only
    ? only.split(",").map((token) => token.trim()).filter(Boolean)
    : null;
  const selectedJobs = onlyFilters
    ? allJobs.filter((job) =>
        onlyFilters.some((token) => job.filename.toLowerCase().includes(token)),
      )
    : allJobs;

  if (list) {
    for (const job of selectedJobs) console.log(job.filename);
    return;
  }

  if (selectedJobs.length === 0) {
    throw new Error(`No capture jobs matched --only=${only}`);
  }

  console.log(
    `Capturing ${selectedJobs.length}/${allJobs.length} Retina screenshots into ${OUTPUT_DIR}`,
  );

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

  const failures = [];
  const results = [];

  try {
    for (const job of selectedJobs) {
      const started = Date.now();
      try {
        const stats = await job.run(browser);
        const elapsedMs = Date.now() - started;
        console.log(
          `[PASS] ${job.filename} (${stats.width}x${stats.height}, colors=${stats.uniqueColorBuckets}, lumRange=${stats.luminanceRange}${stats.canvasStats ? `, canvasColors=${stats.canvasStats.uniqueColorBuckets}` : ""}, ${elapsedMs}ms)`,
        );
        results.push({ filename: job.filename, ok: true, stats, elapsedMs });
      } catch (err) {
        const elapsedMs = Date.now() - started;
        const message = err?.stack ?? String(err);
        console.error(`[FAIL] ${job.filename} (${elapsedMs}ms):\n${message}\n`);
        failures.push({ filename: job.filename, message });
      }
    }
  } finally {
    await browser.close();
  }

  console.log(
    `Completed: ${results.length} passed, ${failures.length} failed (expected 41 total).`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
