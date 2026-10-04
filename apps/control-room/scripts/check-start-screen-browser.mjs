import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Start screen guard on the REAL stylesheets (no backend): the three-column
// grid and its narrow-window fallback, the status strip, and WCAG AA contrast
// of the semantic colour pairs in both themes. A rule-order or token
// regression shows up here, where a screenshot would only show it by luck.

const styleNames = ["tokens.css", "theme.css", "start-screen.tokens.css", "start-screen.css"];
const styles = await Promise.all(
  styleNames.map((name) => readFile(new URL(`../src/design/styles/${name}`, import.meta.url), "utf8")),
);

const markup = `
  <style>* { box-sizing: border-box; } body { margin: 0; } #frame { width: 100vw; height: 100vh; }
  ${styles.join("\n")}</style>
  <div id="frame">
    <div class="fm-start">
      <div class="fm-start__rail"><nav><ul class="fm-start-rail__nav"><li><button class="fm-start-rail__item" aria-current="page">Home</button></li></ul></nav></div>
      <main class="fm-start__content"><div class="fm-start__content-inner">
        <div class="fm-start-tiles">
          <button class="fm-start-tile">FDM</button><button class="fm-start-tile">FEM</button>
          <button class="fm-start-tile">Template</button><button class="fm-start-tile">Import</button>
          <button class="fm-start-tile fm-start-tile--script">Open script…</button>
        </div>
        <div class="fm-start-recent-kinds" id="kinds"><span>All · Projects · Scripts</span></div>
        <div class="fm-start-list"><div class="fm-start-row">
          <span class="fm-start-thumb fm-start-thumb--row"></span>
          <span class="fm-start-row__main"><span class="fm-start-row__name"><span class="fm-start-row__name-text">Name</span></span>
          <span class="fm-start-row__path">C:\\data\\fullmag\\projects\\group\\project.fms</span></span>
          <span>FDM</span><span>Ready</span><span class="fm-start-row__size">1 MB</span><span class="fm-start-row__opened">today</span><span class="fm-start-row__pin"></span>
        </div>
        <div class="fm-start-row" id="script-row" data-kind="script">
          <span class="fm-start-thumb fm-start-thumb--row fm-start-thumb--script"></span>
          <span class="fm-start-row__main"><span class="fm-start-row__name"><span class="fm-start-row__name-text">sp4</span></span>
          <span class="fm-start-row__path">C:/data/fullmag/scripts/group</span></span>
          <span class="fm-start-badge fm-start-badge--script" id="py-badge">.py</span>
          <span class="fm-start-pill fm-start-pill--ready"><span class="fm-start-pill__dot"></span>Run ok</span>
          <span class="fm-start-row__size">120 lines</span><span class="fm-start-row__opened">today</span><span class="fm-start-row__pin"></span>
        </div></div>
      </div></main>
      <aside class="fm-start__inspector" id="inspector">Inspector</aside>
      <footer class="fm-start-status"><span class="fm-start-status__item">No active session</span></footer>
    </div>
  </div>`;

const luminance = ([r, g, b]) => {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Local runs use installed Chrome; CI installs only Playwright Chromium and
// sets CONTROL_ROOM_BROWSER_CHANNEL=chromium.
const browserChannel = process.env.CONTROL_ROOM_BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch(browserChannel === "chromium" ? {} : { channel: browserChannel });
const failures = [];
try {
  const page = await browser.newPage();
  await page.setContent(markup);

  // ── Layout ────────────────────────────────────────────────────────────
  const layout = async (width, height) => {
    await page.setViewportSize({ width, height });
    return page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const start = rect(".fm-start");
      const inspector = document.querySelector("#inspector");
      const tiles = [...document.querySelectorAll(".fm-start-tile")].map((t) => t.getBoundingClientRect().top);
      const status = rect(".fm-start-status");
      const rail = rect(".fm-start__rail");
      const path = document.querySelector(".fm-start-row__path");
      const columnsOf = (selector) =>
        getComputedStyle(document.querySelector(selector)).gridTemplateColumns.split(" ").length;
      const scriptRow = rect("#script-row");
      const projectRow = rect(".fm-start-row");
      return {
        columns: getComputedStyle(document.querySelector(".fm-start")).gridTemplateColumns.split(" ").length,
        inspectorDisplay: getComputedStyle(inspector).display,
        inspectorWidth: inspector.getBoundingClientRect().width,
        tilesOnOneRow: new Set(tiles.map((t) => Math.round(t))).size === 1,
        statusAtBottom: Math.abs(status.bottom - start.bottom) <= 1,
        statusFullWidth: Math.abs(status.width - start.width) <= 1,
        railAboveStatus: rail.bottom <= status.top + 1,
        scriptRowSharesProjectGrid: columnsOf("#script-row") === columnsOf(".fm-start-row"),
        scriptRowHeightMatches: Math.abs(scriptRow.height - projectRow.height) <= 1,
        pyBadgeWidth: document.querySelector("#py-badge").getBoundingClientRect().width,
        pathDirection: getComputedStyle(path).direction,
        pathTruncates: path.scrollWidth >= path.clientWidth,
      };
    });
  };

  const wide = await layout(1680, 1000);
  assert.equal(wide.columns, 3, "Three columns at 1680px");
  assert.equal(wide.inspectorDisplay !== "none", true, "Inspector visible at 1680px");
  assert.ok(Math.abs(wide.inspectorWidth - 364) <= 1, `Inspector is 364px wide, got ${wide.inspectorWidth}`);
  assert.ok(wide.tilesOnOneRow, "The five launch tiles share one row at 1680px");
  assert.ok(wide.scriptRowSharesProjectGrid, "A script row uses the project row grid");
  assert.ok(wide.scriptRowHeightMatches, "A script row is as tall as a project row");
  assert.ok(wide.pyBadgeWidth > 0, "The .py badge renders");
  assert.ok(wide.statusAtBottom && wide.statusFullWidth, "Status strip spans the bottom");
  assert.ok(wide.railAboveStatus, "Rail ends above the status strip");
  assert.equal(wide.pathDirection, "ltr", "Paths are not right-to-left (it reorders Windows backslashes)");

  const narrow = await layout(1000, 800);
  assert.equal(narrow.columns, 2, "Two columns below 1180px");
  assert.equal(narrow.inspectorDisplay, "none", "Inspector is hidden below 1180px, not left under the rail");
  assert.ok(narrow.statusAtBottom && narrow.statusFullWidth, "Status strip still spans the bottom");

  // ── Contrast ──────────────────────────────────────────────────────────
  const pairs = [
    ["meta text", "--fm-start-meta", ["--fm-bg-app", "--fm-bg-chrome", "--fm-bg-panel", "--fm-bg-surface"]],
    ["primary text", "--fm-text-primary", ["--fm-bg-app", "--fm-bg-chrome", "--fm-bg-panel", "--fm-bg-surface"]],
    ["secondary text", "--fm-text-secondary", ["--fm-bg-app", "--fm-bg-panel", "--fm-bg-surface"]],
    ["active rail item", "--fm-start-nav-active", ["--fm-bg-selected"]],
    ...[
      "ready",
      "running",
      "failed",
      "draft",
      "migrate",
      "missing",
      "readonly",
    ].map((s) => [`status ${s}`, `--fm-project-${s}-text`, ["--fm-bg-app", "--fm-bg-surface", "--fm-bg-selected"]]),
    ["FDM badge", "--fm-solver-fdm-text", ["--fm-bg-surface", "--fm-bg-app"]],
    ["FEM badge", "--fm-solver-fem-text", ["--fm-bg-surface", "--fm-bg-app"]],
    // The .py badge uses primary text on a transparent fill, selected rows included.
    [".py badge", "--fm-text-primary", ["--fm-bg-surface", "--fm-bg-app", "--fm-bg-selected"]],
  ];

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const results = await page.evaluate((pairs) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const resolve = (token) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        probe.remove();
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = computed;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return { rgb: [r, g, b], alpha: a };
      };
      return pairs.flatMap(([label, fg, backgrounds]) =>
        backgrounds.map((bg) => ({ label, fg, bg, foreground: resolve(fg), background: resolve(bg) })),
      );
    }, pairs);
    for (const r of results) {
      if (r.foreground.alpha < 255 || r.background.alpha < 255) continue; // translucent: not decidable alone
      const ratio = contrast(r.foreground.rgb, r.background.rgb);
      if (ratio < 4.5) failures.push(`${theme}: ${r.label} ${r.fg} on ${r.bg} = ${ratio.toFixed(2)}:1`);
    }
    console.log(`${theme}: ${results.length} contrast pairs checked`);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`TOTAL below WCAG AA: ${failures.length}`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log("TOTAL below WCAG AA: 0");
  console.log("Start screen browser check passed.");
}
