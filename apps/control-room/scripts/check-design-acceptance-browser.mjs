import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { designCheckUrl } from "./lib/design-browser-env.mjs";

// Acceptance regressions for the PR #268 follow-up (K1-K6). Unlike overflow-only
// checks, every assertion measures the visible symptom: overlapping label lines,
// a one-character host ID, a squeezed project status, duplicate panel chrome.
// Needs a running DEV group with a loaded model; no solver or physics proof.
// The DEV proxy serves the API only on loopback, so run the pinned Playwright
// image inside the frontend container's network namespace:
//   docker run --rm --network container:<frontend> \
//     -v <frontend-state-volume>:/state/development:ro \
//     -v $PWD/apps/control-room/scripts:/state/development/workspace/apps/control-room/scripts:ro \
//     -v <run-dir>:/out -e CONTROL_ROOM_URL=http://127.0.0.1:8080/workspace \
//     -e CONTROL_ROOM_DESIGN_REPORT_DIR=/out -w /state/development/workspace/apps/control-room \
//     mcr.microsoft.com/playwright:v1.62.1-noble node scripts/check-design-acceptance-browser.mjs
const url = designCheckUrl();
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

    // Audit section 3: status bar, Explorer, Inspector colours, Telemetry.
    const followup = await page.evaluate(() => {
      const statusItems = [...document.querySelectorAll(".fm-status-bar__item")].map((item) => ({
        text: item.textContent,
        clipped: item.scrollWidth > item.clientWidth + 1,
        ellipsis: getComputedStyle(item).textOverflow === "ellipsis" && getComputedStyle(item).display === "block",
      }));
      const engines = [...document.querySelectorAll(".fm-status-bar__engine-label")].map((label) => label.textContent.trim());
      const explorer = document.querySelector('[data-panel-frame="panel-left"]').getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[aria-label="Explorer resource families"] [role="tab"]')].map((tab) => {
        const box = tab.getBoundingClientRect();
        return { name: tab.getAttribute("aria-label"), inside: box.left >= explorer.left - 1 && box.right <= explorer.right + 1 && box.width > 0 };
      });
      const filterRow = document.querySelector(".fm-explorer-filter-row");
      const inspectorText = document.querySelector('[data-panel-frame="panel-right"]').innerText;
      return {
        statusItems,
        engines,
        tabs,
        treeActions: filterRow ? filterRow.querySelectorAll(".fm-explorer-toolbar__action").length : 0,
        footerToolbar: document.querySelectorAll("footer.fm-explorer-toolbar").length,
        rawCssInInspector: /var\(--fm-/.test(inspectorText),
        telemetryCompute: document.querySelectorAll(".fm-footer-telemetry__compute-cta").length,
      };
    });
    for (const item of followup.statusItems) assert(item.ellipsis, `${theme}: status field ellipsizes ${JSON.stringify(item)}`);
    assert.equal(followup.tabs.length, 5, `${theme}: five Explorer tabs`);
    for (const tab of followup.tabs) assert(tab.inside, `${theme}: Explorer tab ${tab.name} fully visible`);
    assert.equal(followup.treeActions, 3, `${theme}: tree actions in the filter row`);
    assert.equal(followup.footerToolbar, 0, `${theme}: no Explorer footer row`);
    assert.equal(followup.rawCssInInspector, false, `${theme}: Inspector shows no raw var(--fm-…)`);
    assert.equal(followup.telemetryCompute, 0, `${theme}: Telemetry does not repeat Compute`);

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
    const tileNames = await page.evaluate(() => [...document.querySelectorAll(".fm-start-tile__name")].map((name) => ({
      text: name.textContent, lines: name.getBoundingClientRect().height <= parseFloat(getComputedStyle(name).fontSize) * 1.8 ? 1 : 2,
      clipped: name.scrollWidth > name.clientWidth + 1,
    })));
    for (const name of tileNames) assert(name.lines <= 1 && !name.clipped, `${theme}: launch tile title on one line ${JSON.stringify(name)}`);
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
    if (drawers["panel-left"] && drawers["panel-right"]) assert(drawers["panel-left"][1] <= drawers["panel-right"][0] + 1, `${theme}: open drawers do not overlap ${JSON.stringify(drawers)}`);

    results.push({ theme, ribbon, labels: labels.length, workspaceHeader, inspectorMenu, viewportMenu, gl, followup, hostId, homeHeader, tileNames, drawers });
    await context.close();
  }

  // K3 pending state: a slow host inventory must not push the status pill past the card.
  const pendingContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await pendingContext.addInitScript((apiBase) => {
    window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ ?? {}), controlRoomApiBase: apiBase };
  }, new URL(url).origin);
  await pendingContext.route("**/v2/platform/compute/nodes**", () => {});
  const pendingPage = await pendingContext.newPage();
  pendingPage.on("pageerror", (error) => errors.push({ theme: "pending", message: error.message }));
  await pendingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await pendingPage.getByRole("treeitem", { name: objectName, exact: true }).waitFor({ timeout: 120_000 });
  await pendingPage.getByRole("button", { name: "Home", exact: true }).click();
  const pendingCard = pendingPage.locator(".fm-start-node-summary__card").first();
  await pendingCard.waitFor({ timeout: 30_000 });
  const pending = await pendingCard.evaluate((card) => {
    const box = card.getBoundingClientRect();
    const pill = card.querySelector(".fm-start-compute-settings__status").getBoundingClientRect();
    const title = card.querySelector("h3").getBoundingClientRect();
    return { cardRight: box.right, pillRight: pill.right, titleHeight: title.height, text: card.textContent };
  });
  assert(pending.pillRight <= pending.cardRight + 0.5, `pending status pill stays inside the card ${JSON.stringify(pending)}`);
  assert(pending.titleHeight < 20, `pending card title stays on one line ${JSON.stringify(pending)}`);
  await pendingPage.screenshot({ path: resolve(output, "home-pending.png") });
  results.push({ theme: "pending", pending });
  await pendingContext.close();
} finally {
  await browser.close();
  await writeFile(resolve(output, "result.json"), JSON.stringify({ url, objectName, results, errors }, null, 2));
}
assert.deepEqual(errors, [], "No uncaught application errors");
console.log(JSON.stringify({ cases: results.length, output }));
