import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import { designCheckUrl } from "./lib/design-browser-env.mjs";
(async () => {
  const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
  assert(output, "Set CONTROL_ROOM_DESIGN_REPORT_DIR to the task run directory");
  fs.mkdirSync(output, { recursive: true });
  const b = await chromium.launch({
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
  const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  try {
    await p.goto(designCheckUrl(), {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await p.getByRole("treeitem", { name: "mixed_p1_box_prism", exact: true }).waitFor({ timeout: 120000 });
    await p.getByRole("treeitem", { name: "mixed_p1_box_prism", exact: true }).click();
    const panel = p.locator('[data-panel-frame="panel-right"]');
    await panel.locator(".fm-inspector__body input").first().waitFor({ timeout: 30000 });
    const nameInput = panel.getByRole("textbox", { name: "Name", exact: true });
    const originalName = await nameInput.inputValue();
    const draftName = originalName + "_ui_draft";
    await nameInput.fill(draftName);
    const form = await panel
      .locator("input")
      .evaluateAll((es) => es.map((e) => ({ label: e.getAttribute("aria-label"), value: e.value, type: e.type })));
    console.log(JSON.stringify({ form }));
    await panel.evaluate((e) => {
      e.__original = e;
      window.__panelMarker = e.querySelector(".fm-inspector");
    });
    await p.getByRole("button", { name: "Inspector panel menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Float panel", exact: true }).click();
    await p.waitForTimeout(500);
    assert.equal(await panel.getAttribute("data-panel-mode"), "floating");
    assert.equal(
      await p.evaluate(
        () => window.__panelMarker === document.querySelector('[data-panel-frame="panel-right"] .fm-inspector'),
      ),
      true,
    );
    let box = await panel.boundingBox();
    assert(box.width > 200 && box.height > 100);
    await p.getByRole("button", { name: "Move Inspector with arrow keys", exact: true }).focus();
    await p.keyboard.press("ArrowRight");
    await p.keyboard.press("ArrowDown");
    let moved = await panel.boundingBox();
    assert(moved.x > box.x && moved.y > box.y);
    await p.getByRole("button", { name: "Resize Inspector with arrow keys", exact: true }).focus();
    await p.keyboard.press("ArrowRight");
    let resized = await panel.boundingBox();
    assert(resized.width > moved.width);
    await p.getByRole("button", { name: "Inspector panel menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Maximize panel", exact: true }).click();
    box = await panel.boundingBox();
    assert(box.width > 1400);
    await p.getByRole("button", { name: "Inspector panel menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Restore panel", exact: true }).click();
    assert.equal(await panel.getAttribute("data-panel-mode"), "floating");
    await nameInput.focus();
    await p.getByRole("button", { name: "Inspector panel menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Hide panel", exact: true }).click();
    await p.getByRole("button", { name: "Restore Inspector", exact: true }).click();
    assert.equal(
      await p.evaluate(
        () => window.__panelMarker === document.querySelector('[data-panel-frame="panel-right"] .fm-inspector'),
      ),
      true,
    );
    assert.equal(await nameInput.inputValue(), draftName);
    await p.waitForFunction(
      () =>
        document.querySelector('[data-panel-frame="panel-right"] input[aria-label="Name"]') === document.activeElement,
    );
    assert.equal(await nameInput.evaluate((e) => e === document.activeElement), true);
    await p.getByRole("button", { name: "Inspector panel menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Dock panel", exact: true }).click();
    assert.equal(await panel.getByRole("button", { name: "Revert", exact: true }).count(), 1);
    await panel.locator(".fm-inspector__action-bar").getByRole("button", { name: "Revert", exact: true }).click();
    await p.waitForTimeout(300);
    assert.equal(await nameInput.inputValue(), originalName);
    const cdp = await p.context().newCDPSession(p);
    async function capture(name) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(output + "/" + name, Buffer.from(shot.data, "base64"));
    }
    await capture("object-restored.png");
    await p.getByRole("treeitem", { name: "Airbox", exact: true }).click();
    await panel.getByRole("heading", { name: "Domain policy", exact: true }).waitFor();
    assert.equal(await panel.locator(".fm-scientific-inspector__identity").count(), 0);
    await capture("airbox.png");
    await p.setViewportSize({ width: 900, height: 1000 });
    await p.waitForTimeout(200);
    const drawerBefore = await panel.boundingBox();
    await p.getByRole("button", { name: "Move Inspector with arrow keys", exact: true }).focus();
    await p.keyboard.press("ArrowLeft");
    const drawerMoved = await panel.boundingBox();
    assert(drawerMoved.x < drawerBefore.x, "Responsive drawer handle must move the panel");
    await p.getByRole("button", { name: "Resize Inspector with arrow keys", exact: true }).focus();
    await p.keyboard.press("ArrowRight");
    const drawerResized = await panel.boundingBox();
    assert(drawerResized.width > drawerMoved.width, "Responsive drawer handle must resize the panel");
    const metrics = await p
      .locator(".fm-footer-telemetry__metrics-grid")
      .evaluate((e) => ({
        height: e.clientHeight,
        scrollHeight: e.scrollHeight,
        containerHeight: e.parentElement.clientHeight,
      }));
    assert(metrics.height <= metrics.containerHeight + 1, "Telemetry scrolling must be constrained by the dock");
    await p.setViewportSize({ width: 1440, height: 1100 });
    const airbox = await panel.locator("h2,h3").allTextContents();
    const canvas = await p.locator("canvas").evaluate((c) => {
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return {
        visible: c.getBoundingClientRect().width > 0,
        contextLost: gl.isContextLost(),
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
      };
    });
    assert(canvas.visible && !canvas.contextLost && canvas.width > 0 && canvas.height > 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      output + "/behavior.json",
      JSON.stringify(
        {
          form,
          airbox,
          canvas,
          errors,
          metrics,
          checks: [
            "stable DOM float/maximize/hide/dock",
            "keyboard move/resize",
            "restore previous floating mode",
            "local draft survives hide and float without Apply",
            "Airbox has one identity",
          ],
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ airbox, canvas, errors, passed: true }));
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
