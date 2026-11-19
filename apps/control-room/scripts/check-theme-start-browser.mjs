import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { designCheckUrl } from "./lib/design-browser-env.mjs";

const url = designCheckUrl();
const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
assert(output, "Provide the task's registered report directory.");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const observations = [];
const errors = [];
let failure = null;
try {
  // Abort application chunks: the inline document-head script must work before hydration.
  for (const [preference, system, expected] of [
    ["light", "dark", "light"],
    ["dark", "light", "dark"],
    ["system", "light", "light"],
    ["system", "dark", "dark"],
  ]) {
    const context = await browser.newContext({ colorScheme: system });
    await context.addInitScript((value) => localStorage.setItem("fullmag.control-room.theme", value), preference);
    const page = await context.newPage();
    await page.route("**/_next/static/chunks/**", (route) => route.abort());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const theme = await page.locator("html").getAttribute("data-theme");
    assert.equal(theme, expected, `Pre-hydration theme for ${preference}/${system}`);
    observations.push({ kind: "pre-hydration", preference, system, theme });
    await context.close();
  }

  const context = await browser.newContext({ colorScheme: "dark" });
  await context.addInitScript((apiBase) => {
    localStorage.setItem("fullmag.control-room.theme", "system");
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: apiBase,
      disableRealtime: true,
    };
  }, new URL(url).origin);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat|did not match/i.test(message.text())) errors.push(message.text());
  });
  await page.route("**/v2/**", async (route) => {
    const isSessions = new URL(route.request().url()).pathname === "/v2/sessions";
    await route.fulfill({
      status: isSessions ? 200 : 404,
      contentType: "application/json",
      headers: { "x-api-contract-version": "1.0.0" },
      body: JSON.stringify(
        isSessions ? { schema_version: "2.0.0", sessions: [] } : { error: { code: "theme_fixture_unavailable" } },
      ),
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("button", { name: "Color theme: System (currently dark)" }).waitFor({ timeout: 90_000 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("fullmag.control-room.theme")), "system");
  const fonts = await page.evaluate(async () => {
    await Promise.all([document.fonts.load('12px "Inter"'), document.fonts.load('12px "JetBrains Mono"')]);
    return [...document.fonts]
      .filter((font) => /Inter|JetBrains/.test(font.family))
      .map((font) => ({ family: font.family, status: font.status }));
  });
  for (const name of ["Inter", "JetBrains Mono"])
    assert(
      fonts.some((font) => font.family.replaceAll('"', "") === name && font.status === "loaded"),
      `${name} asset loads`,
    );
  await page.getByRole("button", { name: "Color theme: System (currently dark)" }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.themePreference === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.evaluate(() => localStorage.getItem("fullmag.control-room.theme")), "light");
  observations.push({ kind: "hydrated-system-switch", fonts, persistedExplicitPreference: "light" });
  assert.deepEqual(errors, []);
  await context.close();
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, "theme-result.json"),
    JSON.stringify(
      {
        scope: "Task frontend; mocked empty-session API; pre-hydration chunks blocked for startup cases.",
        observations,
        errors,
        failure,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ cases: observations.length, errors, output }));
