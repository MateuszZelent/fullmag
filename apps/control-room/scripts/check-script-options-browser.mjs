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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await context.addInitScript(() => {
  window.__designHostCalls = [];
  window.__TAURI__ = {
    core: {
      invoke: async (command, _args) => {
        window.__designHostCalls.push(command);
        if (command === "workspace_list")
          return {
            items: [
              {
                id: 7,
                kind: "script",
                name: "design-options-probe",
                path: "/fixture/design-options-probe.py",
                status: "ready",
                meta: { lines: 1, summary: "Browser-only preparation fixture", uses_fullmag: true },
              },
            ],
            outcome: { state: "ready" },
          };
        if (command === "workspace_history") return { events: [] };
        if (command === "script_open_recent")
          return {
            ticket: "design-options-probe-ticket",
            item_id: 7,
            name: "design-options-probe.py",
            display_path: "/fixture/design-options-probe.py",
            bytes: 1,
            lines: 1,
            sha256: "ab".repeat(32),
            modified_at: "",
            encoding: "utf-8",
          };
        if (command === "script_preflight")
          return { ticket: "design-options-probe-ticket", cli_found: true, active_runs: 0, max_runs: 2 };
        throw Error("Command " + command + " not found");
      },
    },
    event: { listen: async () => () => {} },
  };
});
await page.route("**/v2/**", async (route) => {
  if (new URL(route.request().url()).pathname.includes("/workspace/"))
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  else await route.continue();
});
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator(".fm-viewport-3d canvas").waitFor({ timeout: 90000 });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.locator(".fm-start").waitFor();
  await page.getByText("design-options-probe", { exact: true }).first().click();
  await page.locator('[data-action="run-script"]').click();
  await page.locator('[data-run-phase="ready"]').waitFor();
  await page.locator(".fm-start-run-options select").selectOption("cpu");
  await page.getByLabel("Build the model, then wait for COMPUTE", { exact: true }).uncheck();
  await page.getByLabel("Next to the script", { exact: true }).check();
  const before = {
    device: await page.locator(".fm-start-run-options select").inputValue(),
    wait: await page.getByLabel("Build the model, then wait for COMPUTE", { exact: true }).isChecked(),
    next: await page.getByLabel("Next to the script", { exact: true }).isChecked(),
  };
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("dialog", { name: "Details", exact: true }).waitFor();
  const after = {
    device: await page.locator(".fm-start-run-options select").inputValue(),
    wait: await page.getByLabel("Build the model, then wait for COMPUTE", { exact: true }).isChecked(),
    next: await page.getByLabel("Next to the script", { exact: true }).isChecked(),
  };
  fs.writeFileSync(output + "/resize.json", JSON.stringify({ before, after, errors }, null, 2));
  assert.deepEqual(after, before, "Responsive layout must retain prepared execution options");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  assert.equal(await page.locator(".fm-start-run-options select").inputValue(), "cpu");
  assert.equal(await page.getByLabel("Build the model, then wait for COMPUTE", { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel("Next to the script", { exact: true }).isChecked(), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("dialog", { name: "Details", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator(".fm-start-run-options select").inputValue(), "cpu");
  const calls = await page.evaluate(() => window.__designHostCalls);
  assert(!calls.includes("script_run"));
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    output + "/result.json",
    JSON.stringify(
      {
        scope: "Compiled app with explicit desktop bridge fixture; no script execution",
        before,
        after,
        calls,
        errors,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ before, after, passed: true }));
} catch (error) {
  fs.writeFileSync(
    output + "/failure.json",
    JSON.stringify(
      { failure: String(error), errors, calls: await page.evaluate(() => window.__designHostCalls) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
