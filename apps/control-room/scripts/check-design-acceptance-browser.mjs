import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

// Acceptance regressions for the PR #268 follow-up (K1-K6). Unlike overflow-only
// checks, every assertion measures the visible symptom: overlapping label lines,
// a one-character host ID, a squeezed project status, duplicate panel chrome.
// Needs a running DEV group with a loaded model; no solver or physics proof.
const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3230/workspace";
const objectName = process.env.CONTROL_ROOM_DESIGN_OBJECT ?? "mixed_p1_box_prism";
const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
assert(output, "Set CONTROL_ROOM_DESIGN_REPORT_DIR to the task's registered run directory.");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--use-angle=swiftshader-webgl", "--use-gl=angle"],
});
const results = [];
const errors = [];

async function menuItems(page, trigger) {
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const items = await menu.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  return items.map((item) => item.trim());
}

function headerGeometry(page) {
  return page.evaluate(() => {
    const header = document.querySelector(".fm-header");
    const status = document.querySelector(".fm-header__project-status");
    return {
      headerScroll: header.scrollWidth,
      headerClient: header.clientWidth,
      runControls: document.querySelectorAll(".fm-header [data-run-control]").length,
      quickActions: document.querySelectorAll(".fm-header__quick-actions").length,
      status: status && {
        text: status.textContent.trim(),
        client: status.clientWidth,
        scroll: status.scrollWidth,
      },
    };
  });
}

try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(({ theme, apiBase }) => {
      localStorage.setItem("fullmag.control-room.theme", theme);
      // The page origin proxies the API, also when reached through a container alias.
      window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ ?? {}), controlRoomApiBase: apiBase };
    }, { theme, apiBase: new URL(url).origin });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push({ theme, message: error.message }));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready);
    const object = page.getByRole("treeitem", { name: objectName, exact: true });
    await object.waitFor({ timeout: 120_000 });
    await object.click();
    await page.getByRole("tab", { name: "Workspace", exact: true }).click();

    // K1: placeholders are gone and tabs left without working actions are hidden.
    const ribbon = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll(".fm-ribbon__tabs [role=tab]")].map((tab) => tab.textContent.trim()),
      actions: [...document.querySelectorAll(".fm-ribbon__groups .fm-ribbon-action__label")].map((label) => label.textContent.trim()),
    }));
    for (const tab of ["Definitions", "Automation"]) assert(!ribbon.tabs.includes(tab), `${theme}: empty ${tab} tab is hidden`);
    for (const label of ["Open", "3D Visual", "Focus"]) assert(!ribbon.actions.includes(label), `${theme}: placeholder ${label} is hidden`);

    // K2: title and subtitle share one line inside the label box without overlapping.
    const labels = await page.evaluate(() => [...document.querySelectorAll(".fm-ribbon-group__label")].map((label) => {
      const box = label.getBoundingClientRect();
      const title = label.querySelector(":scope > span").getBoundingClientRect();
      const subtitle = label.querySelector("small")?.getBoundingClientRect() ?? null;
      return { text: label.textContent, box: [box.top, box.bottom], title: [title.left, title.right, title.top, title.bottom], subtitle: subtitle && [subtitle.left, subtitle.right, subtitle.top, subtitle.bottom] };
    }));
    assert(labels.length > 0, `${theme}: ribbon group labels render`);
    for (const label of labels) {
      assert(label.title[2] >= label.box[0] - 0.5 && label.title[3] <= label.box[1] + 0.5, `${theme}: label title fits its row: ${JSON.stringify(label)}`);
      if (label.subtitle) assert(label.subtitle[0] >= label.title[1] - 0.5, `${theme}: subtitle follows title without overlap: ${JSON.stringify(label)}`);
    }

    // K4: the project status keeps a legible width at 1440px.
    const workspaceHeader = await headerGeometry(page);
    assert(workspaceHeader.headerScroll <= workspaceHeader.headerClient + 1, `${theme}: header does not overflow`);
    assert(workspaceHeader.status.client >= 60 && workspaceHeader.status.text.length > 3, `${theme}: project status legible: ${JSON.stringify(workspaceHeader.status)}`);

    // K6: one Inspector chrome row, one menu carrying Copy node ID, one hide button.
    const inspector = page.locator('[data-panel-frame="panel-right"]');
    assert.equal(await inspector.getByRole("button", { name: "Hide Inspector", exact: true }).count(), 1, `${theme}: one Hide Inspector`);
    assert.equal(await inspector.locator(".fm-inspector__header-actions").count(), 0, `${theme}: no second Inspector action row`);
    assert.equal(await inspector.getByRole("button", { name: /panel menu$|options$/ }).count(), 1, `${theme}: one Inspector menu`);
    const inspectorMenu = await menuItems(page, inspector.getByRole("button", { name: "Inspector panel menu", exact: true }));
    assert(inspectorMenu.includes("Copy node ID") && inspectorMenu.includes("Hide panel"), `${theme}: Inspector menu ${inspectorMenu}`);
    for (const duplicate of ["Minimize panel", "Close panel"]) assert(!inspectorMenu.includes(duplicate), `${theme}: no ${duplicate}`);

    const viewport = page.locator('[data-panel-frame="viewport-main"]');
    const viewportMenu = await menuItems(page, viewport.getByRole("button", { name: /panel menu$/ }).first());
    for (const item of ["Float panel", "Maximize panel", "Hide panel"]) assert(!viewportMenu.includes(item), `${theme}: viewport cannot ${item}`);
    assert.equal(await viewport.getAttribute("data-panel-mode"), "docked", `${theme}: viewport stays docked`);
    const gl = await viewport.locator("canvas").first().evaluate((canvas) => {
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      const box = canvas.getBoundingClientRect();
      return { visible: box.width > 0 && box.height > 0, lost: context ? context.isContextLost() : null, buffer: context ? [context.drawingBufferWidth, context.drawingBufferHeight] : null };
    });
    assert(gl.visible && gl.lost === false && gl.buffer[0] > 0 && gl.buffer[1] > 0, `${theme}: WebGL canvas ${JSON.stringify(gl)}`);

    await inspector.getByRole("button", { name: "Hide Inspector", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-restore-panel") === "panel-right", null, { timeout: 5000 });
    await page.locator('[data-restore-panel="panel-right"]').click();
    await inspector.getByRole("button", { name: "Hide Inspector", exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, `workspace-${theme}.png`) });

    // K3/K4: Home shows the full host ID row and no simulation transport.
    await page.getByRole("button", { name: "Home", exact: true }).click();
    const host = page.locator(".fm-start-node-summary__host code").first();
    await host.waitFor({ timeout: 30_000 });
    const hostId = await host.evaluate((code) => ({ text: code.textContent, client: code.clientWidth, scroll: code.scrollWidth }));
    assert(hostId.client >= 60 && hostId.scroll <= hostId.client + 1, `${theme}: host ID readable ${JSON.stringify(hostId)}`);
    const metrics = await page.evaluate(() => {
      const body = document.querySelector(".fm-start-env__body").getBoundingClientRect();
      const last = [...document.querySelectorAll(".fm-start-node-summary__metric")].at(-1).getBoundingClientRect();
      return { bodyBottom: body.bottom, lastBottom: last.bottom };
    });
    assert(metrics.lastBottom <= metrics.bodyBottom + 1, `${theme}: compute metrics not clipped ${JSON.stringify(metrics)}`);
    const homeHeader = await headerGeometry(page);
    assert.equal(homeHeader.runControls, 0, `${theme}: no run controls on Home`);
    assert.equal(homeHeader.quickActions, 0, `${theme}: no quick actions on Home`);
    assert(homeHeader.headerScroll <= homeHeader.headerClient + 1, `${theme}: Home header does not overflow`);
    assert(homeHeader.status.client >= 60, `${theme}: Home project status legible ${JSON.stringify(homeHeader.status)}`);
    await page.screenshot({ path: resolve(output, `home-${theme}.png`) });
    await page.getByRole("button", { name: "Back to simulation", exact: true }).click();

    // K6: narrow drawers open from their own edges.
    await page.setViewportSize({ width: 700, height: 1000 });
    await page.waitForTimeout(300);
    const drawers = await page.evaluate(() => Object.fromEntries(["panel-left", "panel-right"].map((id) => {
      const frame = document.querySelector(`[data-panel-frame="${id}"]`);
      const box = frame?.hidden ? null : frame?.getBoundingClientRect();
      return [id, box ? [box.left, box.right] : null];
    })));
    if (drawers["panel-left"]) assert(drawers["panel-left"][0] <= 16, `${theme}: left drawer at left edge ${drawers["panel-left"]}`);
    if (drawers["panel-right"]) assert(drawers["panel-right"][1] >= 700 - 16, `${theme}: right drawer at right edge ${drawers["panel-right"]}`);

    results.push({ theme, ribbon, labels: labels.length, workspaceHeader, inspectorMenu, viewportMenu, gl, hostId, homeHeader, drawers });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "result.json"), JSON.stringify({ url, objectName, results, errors }, null, 2));
}
assert.deepEqual(errors, [], "No uncaught application errors");
console.log(JSON.stringify({ cases: results.length, output }));
