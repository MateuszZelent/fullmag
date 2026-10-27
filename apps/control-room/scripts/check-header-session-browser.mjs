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
const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
page.setDefaultTimeout(25000);
const results = [];
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator(".fm-viewport-3d canvas").waitFor({ timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1920, height: 1000 });
    if (await page.locator(".fm-start").isVisible())
      await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
    await page.getByRole("button", { name: /^Color theme:/ }).click();
    await page.getByRole("menuitemradio", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
    for (const surface of ["workspace", "home"]) {
      await page.setViewportSize({ width: 1920, height: 1000 });
      if (surface === "home") await page.getByRole("button", { name: "Home", exact: true }).click();
      for (const width of [1920, 1600, 1440, 1366, 1180, 900, 450]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(100);
        const geometry = await page.locator(".fm-header").evaluate((e) => ({
          left: e.getBoundingClientRect().left,
          right: e.getBoundingClientRect().right,
          client: e.clientWidth,
          scroll: e.scrollWidth,
          tinyButtons: [...e.querySelectorAll("button")]
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.width && r.height && (r.width < 24 || r.height < 24);
            })
            .map((b) => b.getAttribute("aria-label") || b.textContent),
          controls: [...e.querySelectorAll("[data-run-control]")].map((x) => ({
            role: x.getAttribute("data-run-control"),
            left: x.getBoundingClientRect().left,
            right: x.getBoundingClientRect().right,
          })),
        }));
        results.push({ theme, surface, width, ...geometry });
        fs.writeFileSync(output + "/progress.json", JSON.stringify(results, null, 2));
        assert(
          geometry.left >= -1 && geometry.right <= width + 1 && geometry.scroll <= geometry.client + 1,
          `${theme}/${surface}/${width}: ${JSON.stringify(geometry)}`,
        );
        assert(geometry.controls.every((c) => c.left >= 0 && c.right <= width));
        assert.deepEqual(geometry.tinyButtons, [], "Header native buttons meet minimum target size");
        const project = page.locator(".fm-header__project-status");
        const original = await project.innerHTML();
        for (const dirty of [false, true]) {
          await project.evaluate((e, dirty) => {
            const name = e.querySelector(".fm-header__project-status-name");
            if (!name) throw Error("Project name presentation missing");
            name.textContent = "Long project name ".repeat(12);
            e.querySelector(".fm-header__project-status-dirty")?.remove();
            if (dirty) {
              const marker = document.createElement("span");
              marker.className = "fm-header__project-status-dirty";
              marker.textContent = " · unsaved";
              e.appendChild(marker);
            }
          }, dirty);
          const longName = await page
            .locator(".fm-header")
            .evaluate((e) => ({
              left: e.getBoundingClientRect().left,
              right: e.getBoundingClientRect().right,
              client: e.clientWidth,
              scroll: e.scrollWidth,
            }));
          results.push({ theme, surface, width, fixture: "long project label DOM length stress", dirty, ...longName });
          fs.writeFileSync(output + "/progress.json", JSON.stringify(results, null, 2));
          assert(
            longName.left >= -1 && longName.right <= width + 1 && longName.scroll <= longName.client + 1,
            `Long project label ${theme}/${surface}/${width}: ${JSON.stringify(longName)}`,
          );
          if (dirty) {
            const marker = await project.locator(".fm-header__project-status-dirty").boundingBox();
            assert(
              marker.width > 0 && marker.x >= 0 && marker.x + marker.width <= width + 1,
              "Unsaved marker remains visible",
            );
          }
        }
        await project.evaluate((e, html) => {
          e.innerHTML = html;
        }, original);
      }
    }
  }
  fs.writeFileSync(
    output + "/result.json",
    JSON.stringify(
      {
        scope: "Actual waiting QA session; header geometry includes session and Home return navigation",
        results,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ cases: results.length, passed: true }));
} finally {
  await browser.close();
}
