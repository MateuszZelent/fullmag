import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// A CSS layout regression: exercise actual styles with both optional headers.
const styles = await Promise.all(["tokens.css", "explorer.css", "inspector-mesh.css"].map(
  (name) => readFile(new URL(`../src/design/styles/${name}`, import.meta.url), "utf8"),
));
// Same channel switch as check-start-screen-browser; the Playwright image uses "chromium".
const browserChannel = process.env.CONTROL_ROOM_BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch(browserChannel === "chromium" ? {} : { channel: browserChannel });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <style>* { box-sizing: border-box; } ${styles.join("\n")}</style>
    <div id="dock" style="width:240px;height:600px">
      <section class="fm-explorer" aria-label="Explorer">
        <div class="fm-explorer-tabs">Model / Results</div>
        <div class="fm-result-context">Result context</div>
        <div class="fm-analysis-field-context">Active analysis overlay</div>
        <div class="fm-explorer-filter-row">
          <label class="fm-explorer-filter">Filter</label>
          <div class="fm-explorer-toolbar" role="group" aria-label="Explorer tree actions">
            <button class="fm-explorer-toolbar__action" aria-label="Expand all explorer nodes">+</button>
            <button class="fm-explorer-toolbar__action" aria-label="Collapse all explorer nodes">-</button>
            <button class="fm-explorer-toolbar__action" aria-label="Reset explorer filter and expand nodes">↻</button>
          </div>
        </div>
        <div class="fm-explorer-tree" role="tree">
          <div class="fm-explorer-tree-row" role="treeitem" style="--fm-tree-depth:6">
            <span class="fm-explorer-tree-row__branch">+</span>
            <span class="fm-explorer-tree-row__icon">m</span>
            <span class="fm-explorer-tree-row__label">Long scientific result label with explicit units (A/m)</span>
            <span class="fm-explorer-tree-row__metadata" aria-hidden="true">
              <span class="fm-explorer-tree-row__status"><span class="fm-explorer-tree-row__status-icon"><svg width="12" height="12"></svg></span><span class="fm-explorer-tree-row__status-text">Meshing failed</span></span>
              <span class="fm-explorer-tree-row__active-field"><svg width="12" height="12"></svg><span class="fm-explorer-tree-row__active-text">active</span></span>
              <span class="fm-explorer-tree-row__badge">Revision 12345 with a long provenance suffix</span>
            </span>
          </div>
          <div class="fm-explorer-tree-row" role="treeitem" style="--fm-tree-depth:4" data-status="validation-blocked">
            <span class="fm-explorer-tree-row__branch"></span>
            <span class="fm-explorer-tree-row__icon">A</span>
            <span class="fm-explorer-tree-row__label">Field solve 2</span>
            <span class="fm-explorer-tree-row__metadata" aria-hidden="true">
              <span class="fm-explorer-tree-row__status"><span class="fm-explorer-tree-row__status-icon"><svg width="12" height="12"></svg></span><span class="fm-explorer-tree-row__status-text">Blocked</span></span>
              <span class="fm-explorer-tree-row__badge">1 output · configured · very long source identity</span>
            </span>
          </div>
        </div>
      </section>
    </div>
    <div class="fm-inspector-colorbar__ramp"></div>
  `);
  const cases = [];
  for (const width of [240, 280, 319, 320, 360, 366, 480, 481, 560]) {
    for (const optionalHeaders of [true, false]) {
      const result = await page.evaluate(({ width, optionalHeaders }) => {
        document.querySelector("#dock").style.width = `${width}px`;
        for (const element of document.querySelectorAll(".fm-result-context, .fm-analysis-field-context")) {
          element.style.display = optionalHeaders ? "" : "none";
        }
        const root = document.querySelector(".fm-explorer").getBoundingClientRect();
        const tree = document.querySelector(".fm-explorer-tree");
        const treeRect = tree.getBoundingClientRect();
        const toolbar = document.querySelector(".fm-explorer-toolbar").getBoundingClientRect();
        const filter = document.querySelector(".fm-explorer-filter").getBoundingClientRect();
        const label = document.querySelector(".fm-explorer-tree-row__label");
        return {
          treeHeight: treeRect.height,
          // Tree actions share the filter row above the tree; no footer row remains.
          toolbarInside: toolbar.right <= root.right + 1 && toolbar.bottom <= treeRect.top + 1 && Math.abs(toolbar.top + toolbar.height / 2 - (filter.top + filter.height / 2)) <= 1 && filter.width > 80,
          labelWidth: label.clientWidth,
          horizontalScroll: tree.scrollWidth > tree.clientWidth,
          rows: [...tree.querySelectorAll("[role=treeitem]")].map(row => {
            const name = row.querySelector(".fm-explorer-tree-row__label"), metadata = row.querySelector(".fm-explorer-tree-row__metadata"), bounds = row.getBoundingClientRect();
            return { name: name.textContent, nameWidth: name.clientWidth, nameScrollWidth: name.scrollWidth, height: bounds.height,
              metadataAfterLabel: name.getBoundingClientRect().right <= metadata.getBoundingClientRect().left + 1,
              metadataInside: metadata.getBoundingClientRect().right <= treeRect.right + 1,
              statusVisible: row.querySelector(".fm-explorer-tree-row__status-icon").getBoundingClientRect().width > 0,
              statusTextVisible: getComputedStyle(row.querySelector(".fm-explorer-tree-row__status-text")).display !== "none",
              badgeVisible: getComputedStyle(row.querySelector(".fm-explorer-tree-row__badge")).display !== "none" };
          }),
          buttons: [...document.querySelectorAll(".fm-explorer-toolbar__action")].map((button) => ({
            accessibleName: button.getAttribute("aria-label"),
            inside: button.getBoundingClientRect().right <= root.right + 1,
          })),
          colorbarShadow: getComputedStyle(document.querySelector(".fm-inspector-colorbar__ramp")).boxShadow,
        };
      }, { width, optionalHeaders });
      assert.ok(result.treeHeight > 350, "Tree must own the remaining panel height");
      assert.ok(result.toolbarInside, "Tree actions sit beside a usable filter field");
      assert.equal(result.buttons.length, 3);
      for (const button of result.buttons) {
        assert.ok(button.accessibleName);
        assert.ok(button.inside);
      }
      assert.equal(result.horizontalScroll, false, "Metadata must not make the tree horizontally scroll");
      for (const row of result.rows) {
        assert.equal(row.height, 28, "Rendered height must match virtualization");
        assert.ok(row.nameWidth > 0 && row.metadataAfterLabel && row.metadataInside, "Metadata must leave a separate label track");
        assert.ok(row.statusVisible, "Compact status keeps a non-color marker");
        assert.equal(row.statusTextVisible, width > 480);
        assert.equal(row.badgeVisible, width > 319);
      }
      if (width >= 280) assert.ok(result.rows[1].nameWidth >= result.rows[1].nameScrollWidth, "Deep Field solve label must be readable in full");
      assert.notEqual(result.colorbarShadow, "none");
      cases.push({ width, optionalHeaders, ...result });
    }
  }
  console.log(JSON.stringify({ status: "PASS", cases }));
} finally {
  await browser.close();
}
