import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// A CSS layout regression: exercise actual styles with both optional headers.
const styles = await Promise.all(["tokens.css", "explorer.css", "inspector-mesh.css"].map(
  (name) => readFile(new URL(`../src/design/styles/${name}`, import.meta.url), "utf8"),
));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <style>* { box-sizing: border-box; } ${styles.join("\n")}</style>
    <div id="dock" style="width:240px;height:600px">
      <section class="fm-explorer" aria-label="Explorer">
        <div class="fm-explorer-tabs">Model / Results</div>
        <div class="fm-result-context">Result context</div>
        <div class="fm-analysis-field-context">Active analysis overlay</div>
        <label class="fm-explorer-filter">Filter</label>
        <div class="fm-explorer-tree" role="tree">
          <div class="fm-explorer-tree-row" role="treeitem">
            <span class="fm-explorer-tree-row__branch">+</span>
            <span class="fm-explorer-tree-row__icon">m</span>
            <span class="fm-explorer-tree-row__label">Long scientific result label with explicit units (A/m)</span>
            <span class="fm-explorer-tree-row__status">completed</span>
            <span class="fm-explorer-tree-row__active-field">active</span>
            <span class="fm-explorer-tree-row__badge">Revision 12345</span>
          </div>
        </div>
        <footer class="fm-explorer-toolbar">
          <button class="fm-explorer-toolbar__action" aria-label="Expand all explorer nodes">+<span>Expand All</span></button>
          <button class="fm-explorer-toolbar__action" aria-label="Collapse all explorer nodes">-<span>Collapse All</span></button>
          <button class="fm-explorer-toolbar__action" aria-label="Refresh explorer">↻<span>Refresh</span></button>
        </footer>
      </section>
    </div>
    <div class="fm-inspector-colorbar__ramp"></div>
  `);
  const cases = [];
  for (const width of [240, 360, 520]) {
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
        const label = document.querySelector(".fm-explorer-tree-row__label");
        return {
          treeHeight: treeRect.height,
          toolbarInside: toolbar.bottom <= root.bottom + 1 && toolbar.top >= treeRect.bottom - 1,
          labelUnclipped: label.clientWidth >= label.scrollWidth,
          horizontalScroll: tree.scrollWidth > tree.clientWidth,
          buttons: [...document.querySelectorAll(".fm-explorer-toolbar__action")].map((button) => ({
            accessibleName: button.getAttribute("aria-label"),
            inside: button.getBoundingClientRect().right <= root.right + 1,
            textVisible: getComputedStyle(button.querySelector("span")).display !== "none",
          })),
          colorbarShadow: getComputedStyle(document.querySelector(".fm-inspector-colorbar__ramp")).boxShadow,
        };
      }, { width, optionalHeaders });
      assert.ok(result.treeHeight > 350, "Tree must own the remaining panel height");
      assert.ok(result.toolbarInside, "Optional headers must not displace the footer");
      for (const button of result.buttons) {
        assert.ok(button.accessibleName);
        assert.ok(button.inside);
        assert.equal(button.textVisible, width > 360);
      }
      if (width <= 360) {
        assert.ok(result.labelUnclipped, "Narrow result label must remain scrollable in full");
        assert.ok(result.horizontalScroll);
      }
      assert.notEqual(result.colorbarShadow, "none");
      cases.push({ width, optionalHeaders, ...result });
    }
  }
  console.log(JSON.stringify({ status: "PASS", cases }));
} finally {
  await browser.close();
}
