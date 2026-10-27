// Requires the task-owned waiting airbox_inspector_mixed QA model. Changes and restores only its object name.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";
import { designCheckUrl } from "./lib/design-browser-env.mjs";
const url = designCheckUrl();
assert.equal(new URL(url).hostname, "127.0.0.1");
const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
assert(output);
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
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
const page = await browser.newPage({ viewport: { width: 1440, height: 780 } });
page.setDefaultTimeout(20000);
let release;
const held = new Promise((resolve) => (release = resolve));
let seen;
const requested = new Promise((resolve) => (seen = resolve));
let heldOnce = false;
let allowCommit = false;
const errors = [],
  receipts = [],
  requests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.url().includes("/v2/")) requests.push({ method: r.method(), path: new URL(r.url()).pathname });
});
await page.route("**/v2/**", async (route) => {
  const r = route.request();
  if (r.method() === "PATCH" && new URL(r.url()).pathname.includes("/model/objects/") && !heldOnce) {
    heldOnce = true;
    seen();
    await held;
    if (!allowCommit) return route.abort();
  }
  await route.continue();
});
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("treeitem", { name: "mixed_p1_box_prism", exact: true }).waitFor({ timeout: 90000 });
  await page.getByRole("treeitem", { name: "mixed_p1_box_prism", exact: true }).click();
  const inspector = page.locator(".fm-inspector");
  const name = inspector.getByRole("textbox", { name: "Name", exact: true });
  await name.waitFor();
  const original = await name.inputValue();
  const changed = original + "_ui_ack";
  const marker = await inspector.elementHandle();
  const notes = inspector.getByRole("textbox", { name: "Notes", exact: true });
  const snapshot = () =>
    inspector.evaluate((root) => ({
      fields: [...root.querySelectorAll("input,textarea,select")].map((e) => ({
        label: e.getAttribute("aria-label"),
        disabled: e.disabled,
        opacity: getComputedStyle(e).opacity,
      })),
      opacityAnimations: root
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getKeyframes().some((k) => "opacity" in k)).length,
      scroll: root.querySelector(".fm-inspector__content .fm-scroll-area__viewport").scrollTop,
    }));
  const baseline = await snapshot();
  await name.fill(changed);
  const responsePromise = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname.includes("/model/objects/"),
  );
  await inspector.locator(".fm-inspector__action-bar").getByRole("button", { name: "Apply", exact: true }).click();
  await Promise.race([
    requested,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("No object PATCH submitted")), 20000);
      timer.unref();
    }),
  ]);
  await notes.focus();
  await inspector.locator(".fm-inspector__content .fm-scroll-area__viewport").evaluate((e) => {
    e.scrollTop = 90;
  });
  const pending = await snapshot();
  assert.deepEqual(pending.fields, baseline.fields);
  assert.equal(pending.opacityAnimations, 0);
  assert(pending.scroll > 0, "Exercise a nonzero Inspector scroll position");
  assert(await marker.evaluate((e) => e === document.querySelector(".fm-inspector")));
  allowCommit = true;
  release();
  const response = await responsePromise;
  const body = await response.json();
  receipts.push({ phase: "commit", status: response.status(), revision: body.revision });
  assert(response.ok(), JSON.stringify(body));
  await page.getByRole("treeitem", { name: changed, exact: true }).waitFor();
  assert(await marker.evaluate((e) => e === document.querySelector(".fm-inspector")));
  assert(await notes.evaluate((e) => e === document.activeElement));
  const ack = await snapshot();
  assert.deepEqual(ack.fields, baseline.fields);
  assert.equal(ack.opacityAnimations, 0);
  assert.equal(ack.scroll, pending.scroll);
  await name.fill(original);
  const restored = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname.includes("/model/objects/"),
  );
  await inspector.locator(".fm-inspector__action-bar").getByRole("button", { name: "Apply", exact: true }).click();
  const restoredResponse = await restored;
  receipts.push({ phase: "restore", status: restoredResponse.status() });
  assert(restoredResponse.ok());
  await page.getByRole("treeitem", { name: original, exact: true }).waitFor();
  assert(!requests.some((r) => r.method === "POST" && /solve|compute_fields|compute-fields/.test(r.path)));
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    output + "/result.json",
    JSON.stringify(
      {
        scope: "Actual waiting QA model, reversible name edit then restore; no Solve",
        baseline,
        pending,
        ack,
        receipts,
        requests,
        errors,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ baseline, pending, ack, receipts, passed: true }));
} catch (error) {
  fs.writeFileSync(
    output + "/failure.json",
    JSON.stringify({ receipts, requests, errors, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  release();
  await browser.close();
}
