import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { designCheckUrl } from "./lib/design-browser-env.mjs";

// Exercises the compiled application against an explicitly empty-session fixture.
// This verifies UI behavior, not backend readiness, physics or WebGL execution.
const url = designCheckUrl();
const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
assert(output, "Set CONTROL_ROOM_DESIGN_REPORT_DIR to the task's registered run directory.");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
const mutations = [];
let failure = null;
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 900, 450]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      await context.addInitScript(
        ({ theme, apiBase }) => {
          localStorage.setItem("fullmag.control-room.theme", theme);
          window.__FULLMAG_CONFIG__ = {
            ...(window.__FULLMAG_CONFIG__ ?? {}),
            allowMissingSessionSmoke: true,
            controlRoomApiBase: apiBase,
            disableRealtime: true,
          };
        },
        { theme, apiBase: new URL(url).origin },
      );
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push({ theme, width, message: error.message }));
      page.on("console", (message) => {
        if (message.type() === "error" && /hydrat|did not match/i.test(message.text())) {
          errors.push({ theme, width, message: message.text() });
        }
      });
      await page.route("**/v2/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
        const sessions = request.method() === "GET" && path === "/v2/sessions";
        await route.fulfill({
          status: sessions ? 200 : 404,
          contentType: "application/json",
          headers: { "x-api-contract-version": "1.0.0" },
          body: JSON.stringify(
            sessions
              ? { schema_version: "2.0.0", sessions: [] }
              : { error: { code: "design_audit_fixture_unavailable", path } },
          ),
        });
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.locator(".fm-header").waitFor({ timeout: 90_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.locator('[data-state="no-session"]').first().waitFor({ timeout: 30_000 });
      await page.locator(".fm-header").waitFor({ timeout: 90_000 });
      const observed = await page.evaluate(() => {
        const header = document.querySelector(".fm-header");
        return {
          theme: document.documentElement.dataset.theme,
          headerWidth: header.clientWidth,
          headerScrollWidth: header.scrollWidth,
          controls: [...header.querySelectorAll("[data-run-control]")].map((node) => ({
            id: node.getAttribute("data-command-id"),
            role: node.getAttribute("data-run-control"),
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
          })),
        };
      });
      const compact = page.getByRole("button", { name: "Main menu", exact: true });
      if (width < 1180) {
        await compact.click();
        await page.getByRole("menuitem", { name: "Home", exact: true }).waitFor();
        await page.getByRole("menuitem", { name: "File", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Main menu", {
          timeout: 5000,
        });
        assert(await compact.evaluate((el) => el === document.activeElement), "Menu restores trigger focus");
      } else {
        await page.getByRole("button", { name: "File", exact: true }).click();
        await page.getByRole("menuitem", { name: /^New Project/ }).waitFor();
        await page.keyboard.press("Escape");
      }
      if (width === 450) {
        await page.getByRole("button", { name: "Open compute environment settings", exact: true }).waitFor();
        const layout = await page.evaluate(() => ({
          rail: document.querySelector(".fm-start__rail")?.getBoundingClientRect().width,
          contentWidth: document.querySelector(".fm-start__content")?.clientWidth,
          contentScroll: document.querySelector(".fm-start__content")?.scrollWidth,
          detailsHidden: getComputedStyle(document.querySelector(".fm-start-env__body")).display === "none",
        }));
        assert(layout.rail <= 64, "Narrow Home rail must release space to the content");
        assert(layout.contentScroll <= layout.contentWidth, "Home content must not overflow");
        assert(layout.detailsHidden, "Narrow rail keeps compute details in Settings");
        assert(await page.getByRole("button", { name: "Open compute environment settings", exact: true }).isVisible());
      }
      if (width < 1180) {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const details = page.getByRole("button", { name: "Details", exact: true });
        await details.click();
        await page.getByRole("dialog", { name: "Details", exact: true }).waitFor();
        assert.equal(await page.locator(".fm-start__inspector").count(), 1, "One Home details presentation");
        await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "Details", exact: true }).waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.hasAttribute("data-start-details-trigger"));
        if (width === 900) {
          await details.click();
          await page.getByRole("dialog", { name: "Details", exact: true }).waitFor();
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.getByRole("dialog", { name: "Details", exact: true }).waitFor({ state: "hidden" });
          await page.waitForFunction(() => document.activeElement?.matches("main.fm-start__content"));
          assert.equal(await page.locator(".fm-start__inspector").count(), 1, "One desktop details presentation");
          await page.setViewportSize({ width, height: 1000 });
        }
        await page.getByRole("button", { name: "Overview", exact: true }).click();
      }
      await page.screenshot({ path: resolve(output, `home-${theme}-${width}.png`) });
      results.push({ expectedTheme: theme, width, ...observed });
      await context.close();
    }
  }
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        scope: "Compiled task frontend, mocked empty-session API, DPR 1. No solver or runtime proof.",
        results,
        errors,
        mutations,
        failure,
      },
      null,
      2,
    ),
  );
}
assert.deepEqual(errors, [], "No uncaught application errors");
assert.deepEqual(mutations, [], "Navigation never submits runtime mutations");
for (const result of results) {
  assert.equal(result.theme, result.expectedTheme, "Theme matches preference");
  assert(result.headerScrollWidth <= result.headerWidth + 1, `Header overflows at ${result.width}px (${result.theme})`);
  assert.equal(result.controls.length, 0, "The start screen shows no simulation transport");
}
console.log(JSON.stringify({ cases: results.length, errors: errors.length, mutations: mutations.length, output }));
