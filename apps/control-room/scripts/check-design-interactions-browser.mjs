// Native browser zoom uses an isolated MV3 extension and persistent profile.
// References: https://playwright.dev/docs/chrome-extensions and https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { designCheckUrl } from "./lib/design-browser-env.mjs";

const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
assert(output);
const url = designCheckUrl();
assert.equal(new URL(url).hostname, "127.0.0.1", "Use only the selected task loopback runtime");
fs.mkdirSync(output, { recursive: true });
const extension = path.join(output, "zoom-extension");
fs.mkdirSync(extension, { recursive: true });
fs.writeFileSync(
  path.join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Fullmag isolated browser zoom check",
    version: "1.0",
    host_permissions: ["http://127.0.0.1/*"],
    background: { service_worker: "worker.js" },
  }),
);
fs.writeFileSync(path.join(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});");
const args = [
  "--headless=new",
  "--disable-dev-shm-usage",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--no-sandbox",
  "--use-angle=swiftshader-webgl",
  "--use-gl=angle",
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
];
const context = await chromium.launchPersistentContext(path.join(output, "profile-" + Date.now()), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
  args,
});
const errors = [],
  mutations = [],
  checks = [];
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
context.on("request", (r) => {
  if (new URL(r.url()).origin === new URL(url).origin && !["GET", "HEAD", "OPTIONS"].includes(r.method()))
    mutations.push({ method: r.method(), url: r.url() });
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  const ribbon = page.locator(".fm-ribbon");
  await ribbon.waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: /^Ribbon density:/ }).click();
  await page.getByRole("menuitemradio", { name: "Full", exact: true }).click();
  await ribbon.getByRole("tab", { name: "Workspace", exact: true }).click();
  const toolbar = ribbon.getByRole("toolbar").first();
  const items = toolbar.locator(
    'button[data-ribbon-toolbar-item="true"]:not(:disabled), .fm-ribbon-action-shell[data-disabled-reason]',
  );
  assert((await items.count()) > 1);
  await items.first().focus();
  await page.keyboard.press("End");
  assert(await items.last().evaluate((e) => e === document.activeElement));
  await page.keyboard.press("Home");
  assert(await items.first().evaluate((e) => e === document.activeElement));
  await page.keyboard.press("ArrowRight");
  assert(await items.nth(1).evaluate((e) => e === document.activeElement));
  await page.keyboard.press("ArrowLeft");
  assert(await items.first().evaluate((e) => e === document.activeElement));
  checks.push("Ribbon toolbar ArrowRight/ArrowLeft/Home/End");
  await page.getByRole("button", { name: /^Ribbon density:/ }).click();
  await page.getByRole("menuitemradio", { name: "Compact", exact: true }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".fm-ribbon")?.dataset.density === "compact");
  checks.push("Ribbon density persists after reload");
  const before = await page.evaluate(() => ({
    width: innerWidth,
    dpr: devicePixelRatio,
    headerWidth: document.querySelector(".fm-header").clientWidth,
    headerScroll: document.querySelector(".fm-header").scrollWidth,
    headerLeft: document.querySelector(".fm-header").getBoundingClientRect().left,
  }));
  assert(
    before.headerScroll <= before.headerWidth + 1 && before.headerLeft >= -1,
    "Active session header must fit at 1440px",
  );
  const zoom = await worker.evaluate(async (expected) => {
    const tabs = await chrome.tabs.query({ url: expected + "/*" });
    if (tabs.length !== 1)
      throw Error(
        "Expected exactly one isolated app tab: " + JSON.stringify(tabs.map((t) => ({ id: t.id, url: t.url }))),
      );
    await chrome.tabs.setZoom(tabs[0].id, 2);
    return chrome.tabs.getZoom(tabs[0].id);
  }, new URL(url).origin);
  assert.equal(zoom, 2);
  await page.waitForFunction((w) => innerWidth <= w / 2 + 1, before.width);
  const after = await page.evaluate(() => ({
    width: innerWidth,
    dpr: devicePixelRatio,
    headerWidth: document.querySelector(".fm-header").clientWidth,
    headerScroll: document.querySelector(".fm-header").scrollWidth,
  }));
  console.log(
    JSON.stringify({
      before,
      after,
      zoom,
      header: await page
        .locator(".fm-header")
        .evaluate((e) =>
          [...e.children].map((c) => ({
            className: c.className,
            width: c.getBoundingClientRect().width,
            scroll: c.scrollWidth,
            display: getComputedStyle(c).display,
          })),
        ),
    }),
  );
  assert(after.headerScroll <= after.headerWidth + 1);
  assert(after.dpr >= before.dpr * 1.99);
  checks.push("Native Chromium zoom 200% verified by chrome.tabs.getZoom, CSS viewport and DPR");
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: /^Color theme:/ }).click();
    await page.getByRole("menuitemradio", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
    await page.getByRole("button", { name: "Main menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Home", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    const cdp = await context.newCDPSession(page);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, `workspace-${theme}-zoom200.png`), Buffer.from(shot.data, "base64"));
    await cdp.detach();
  }
  await page.getByRole("button", { name: "Main menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Home", exact: true }).click();
  await page.locator(".fm-start").waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Details", exact: true });
  await sheet.waitFor();
  await page.keyboard.press("Escape");
  const copy = page.getByRole("button", { name: "Copy full compute host ID", exact: true }).first();
  await copy.waitFor();
  const full = await copy.getAttribute("title");
  assert(full?.length > 24);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__designCopied = value;
        },
      },
    }),
  );
  await copy.click();
  await page.waitForFunction((value) => window.__designCopied === value, full);
  checks.push("Full compute host ID copied through isolated clipboard stub at native 200% zoom");
  const embedded = await context.newPage();
  await embedded.addInitScript(() => {
    window.name = "fullmag-instance-tab";
  });
  await embedded.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await embedded.locator(".fm-header").waitFor();
  await embedded.locator(".fm-instance-tabs").waitFor({ state: "detached" });
  assert.equal(await embedded.locator(".fm-instance-tabs").count(), 0);
  await embedded.getByRole("button", { name: "Main menu", exact: true }).click();
  await embedded.getByRole("menuitem", { name: "Home", exact: true }).click();
  await embedded.locator(".fm-start").waitFor();
  checks.push("Embedded instance omits strip and retains menu Home");
  assert.deepEqual(errors, []);
  assert(
    mutations.every((r) => new URL(r.url).pathname.endsWith("/visualization/client-acks")),
    "Navigation may acknowledge the displayed visualization but must not submit commands",
  );
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        scope:
          "Actual task frontend and waiting QA model; SwiftShader, no Solve; isolated clipboard stub; native browser zoom",
        before,
        after,
        zoom,
        checks,
        errors,
        mutations,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ zoom, before, after, checks, passed: true }));
} catch (error) {
  fs.writeFileSync(
    path.join(output, "failure.json"),
    JSON.stringify({ checks, errors, mutations, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await context.close();
}
