import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { FIXTURE_DETAILS } from "../fixtures/start-screen-workspace-api.mjs";

// Layout and contrast guard for the start screen's right-hand inspector, on
// the real stylesheets and the REAL components: the three inspectors (project,
// script, result folder) are rendered to markup through Vite's SSR loader and
// placed in the start screen grid. Checked against the approved sketch
// (docs/design/start-screen/mockups/reference-start-screen-2026-10-03.html):
// right column width, preview on top, title with star and menu, path with
// copy, chips, tabs, sections, and the bottom action bar; plus WCAG AA of
// every text the inspectors draw, in both themes.

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Renders the inspectors with Vite's SSR loader; returns markup builders and a closer. */
export async function loadInspectorMarkup() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: false,
    root: appRoot,
    appType: "custom",
    logLevel: "error",
    resolve: { alias: { "@": `${appRoot}src` } },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (path) => server.ssrLoadModule(path);
  // React stays a plain Node import, so the modules Vite loads share this instance.
  const react = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const types = await load("/src/modules/start/model/workspaceApiTypes.ts");
  const { ProjectDetails } = await load("/src/modules/start/inspector/ProjectDetails.tsx");
  const { ScriptInspector } = await load("/src/modules/start/inspector/ScriptInspector.tsx");
  const { ResultInspector } = await load("/src/modules/start/inspector/ResultInspector.tsx");
  const adapters = await load("/src/modules/start/model/workspaceApiAdapters.ts");

  const h = react.createElement;
  const render = (component, props) => renderToStaticMarkup(h(component, props));
  const answer = (id) => ({ kind: "ready", answer: types.parseApiItemDetailAnswer(FIXTURE_DETAILS[id]) });
  const noop = () => undefined;
  const thumbnailUrl = (id) => `data:image/gif;base64,R0lGODlhAQABAAAAACw=#${id}`;

  const projectItem = types.parseApiWorkspaceItem(FIXTURE_DETAILS["wi-project-yig"].item);
  const projectEntry = adapters.apiProjectToEntry(projectItem, { thumbnailUrl });
  const scriptItem = types.parseApiWorkspaceItem(FIXTURE_DETAILS["wi-script-sp4"].item);
  const resultItem = types.parseApiWorkspaceItem(FIXTURE_DETAILS["wi-result-sp4-run3"].item);

  const projectProps = {
    entry: projectEntry,
    openDisabledReason: null,
    detail: answer("wi-project-yig"),
    onOpen: noop,
    onOpenResults: noop,
    onTogglePin: noop,
    onForget: noop,
    onSelectResult: noop,
  };
  const scriptProps = {
    item: adapters.apiScriptToItem(scriptItem),
    detail: answer("wi-script-sp4"),
    readOnly: false,
    desktopId: null,
    onOpen: noop,
    onReveal: noop,
    onReadText: noop,
    onTogglePin: noop,
    onForget: noop,
    onSelectResult: noop,
    thumbnailUrl,
  };
  const resultProps = {
    item: resultItem,
    detail: answer("wi-result-sp4-run3"),
    readOnly: false,
    thumbnailUrl,
    onTogglePin: noop,
    onForget: noop,
    onSelectSource: noop,
    onOpenResults: noop,
    openDisabledReason: null,
  };

  return {
    markup: {
      project: render(ProjectDetails, projectProps),
      projectRuns: render(ProjectDetails, { ...projectProps, initialTab: "runs" }),
      projectReadOnly: render(ProjectDetails, {
        ...projectProps,
        entry: { ...projectEntry, mode: "read_only", modeReason: "Opened from a read-only share." },
      }),
      script: render(ScriptInspector, scriptProps),
      scriptHistory: render(ScriptInspector, { ...scriptProps, initialTab: "history" }),
      scriptRuns: render(ScriptInspector, { ...scriptProps, initialTab: "runs" }),
      result: render(ResultInspector, resultProps),
      resultStages: render(ResultInspector, { ...resultProps, initialTab: "stages" }),
    },
    close: () => server.close(),
  };
}

const page = (styles, inspector) => `
  <style>* { box-sizing: border-box; } body { margin: 0; } #frame { width: 100vw; height: 100vh; }
  ${styles.join("\n")}</style>
  <div id="frame">
    <div class="fm-start" data-section="home">
      <div class="fm-start__rail"><nav><ul class="fm-start-rail__nav"><li><button class="fm-start-rail__item" aria-current="page">Home</button></li></ul></nav></div>
      <main class="fm-start__content"><div class="fm-start__content-inner"><p>Recent work</p></div></main>
      ${inspector}
      <footer class="fm-start-status"><span class="fm-start-status__item">No active session</span></footer>
    </div>
  </div>`;

const EXPECTED = {
  project: {
    tabs: ["Overview", "Authors", "History", "Runs"],
    sections: ["Model", "Execution", "Outputs"],
    primary: "Open project",
  },
  script: {
    tabs: ["Overview", "History", "Runs"],
    sections: ["Summary", "Facts", "Checks", "Last run"],
    primary: "Open script",
  },
  result: {
    tabs: ["Overview", "Stages", "History"],
    sections: ["Run", "Source", "Data", "Folder"],
    primary: "Open results viewer",
  },
};

/** Geometry of the inspector parts, measured in the page. */
function measureInspector() {
  const inspector = document.querySelector(".fm-start__inspector");
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const text = (element) => element?.textContent?.trim() ?? "";
  const start = document.querySelector(".fm-start").getBoundingClientRect();
  const foot = inspector.querySelector(".fm-start-inspector__foot");
  const buttons = foot ? [...foot.querySelectorAll("button")] : [];
  const primary = foot?.querySelector(".fm-start-inspector__open");
  const split = foot?.querySelector(".fm-start-btn-group__split");
  const external = buttons.at(-1);
  // The split button is joined to the primary one by a 1px border overlap; more than that is a collision.
  const overlaps = (a, b) => a && b && a.left < b.right - 1.5 && b.left < a.right - 1.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const parts = [box(primary), box(split), box(external)];
  const tabs = [...inspector.querySelectorAll('[role="tab"]')];
  const panel = inspector.querySelector('[role="tabpanel"]');
  return {
    start: { right: start.right, bottom: start.bottom },
    inspector: box(inspector),
    scrollWidth: inspector.scrollWidth,
    clientWidth: inspector.clientWidth,
    preview: box(inspector.querySelector(".fm-start-preview")),
    title: text(inspector.querySelector("h2")),
    pinLabel: inspector.querySelector('[aria-pressed]')?.getAttribute("aria-label") ?? "",
    moreActions: box(inspector.querySelector('[aria-label="More actions"]')),
    copyPath: box(inspector.querySelector('[aria-label="Copy path"]')),
    path: text(inspector.querySelector(".fm-start-inspector__path > span")),
    chips: inspector.querySelectorAll(".fm-start-chips > *").length,
    tabNames: tabs.map(text),
    tabTops: [...new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)))],
    selectedTabs: tabs.filter((t) => t.getAttribute("aria-selected") === "true").length,
    panel: box(panel),
    panelLabelled: panel?.getAttribute("aria-labelledby") ?? "",
    sections: [...inspector.querySelectorAll(".fm-start-kv__title")].map(text),
    tableHeaders: [...inspector.querySelectorAll("th[scope=col]")].map(text),
    foot: box(foot),
    primaryText: text(primary),
    parts,
    split: !!split,
    footOverlap: [overlaps(parts[0], parts[1]), overlaps(parts[0], parts[2]), overlaps(parts[1], parts[2])].some(Boolean),
    partsInside: parts.filter(Boolean).every((p) => p.left >= inspector.getBoundingClientRect().left - 1 && p.right <= inspector.getBoundingClientRect().right + 1),
    banners: [...inspector.querySelectorAll(".fm-start-banner")].map((b) => {
      const r = b.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    }),
    viewportHeight: window.innerHeight,
  };
}

/** The text of the inspector against the colours actually behind it, in the current theme. */
function measureTextContrast() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const pixelOf = (color, under) => {
    ctx.clearRect(0, 0, 1, 1);
    if (under) {
      ctx.fillStyle = `rgb(${under.join(",")})`;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  };
  const backdrop = (element) => {
    const chain = [];
    for (let node = element; node; node = node.parentElement) chain.unshift(node);
    let colour = [255, 255, 255];
    for (const node of chain) {
      const background = getComputedStyle(node).backgroundColor;
      if (background && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
        colour = pixelOf(background, colour);
      }
    }
    return colour;
  };
  const lum = ([r, g, b]) => {
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const results = [];
  const inspector = document.querySelector(".fm-start__inspector");
  for (const element of inspector.querySelectorAll("*")) {
    const own = [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
    if (!own) continue;
    if (element.closest("button:disabled, [disabled]")) continue; // a disabled control is exempt
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    // The preview label is drawn over the thumbnail frame, not over the panel.
    const over = element.classList.contains("fm-start-preview__label")
      ? pixelOf(getComputedStyle(element.closest(".fm-start-preview").querySelector(".fm-start-thumb")).backgroundColor)
      : backdrop(element);
    const foreground = pixelOf(style.color, over);
    results.push({
      text: element.textContent.trim().slice(0, 40),
      selector: `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`,
      ratio: ratio(foreground, over),
    });
  }
  return results;
}

export async function checkInspectors({ browser, styles, markup, failures }) {
  const tab = await browser.newPage();
  try {
    const show = async (html, width = 1600, height = 1000) => {
      await tab.setViewportSize({ width, height });
      await tab.setContent(page(styles, html));
      await tab.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    };

    for (const [kind, expected] of Object.entries(EXPECTED)) {
      await show(markup[kind]);
      const m = await tab.evaluate(measureInspector);
      const label = `${kind} inspector`;

      // The right-hand column of the sketch: 364 px wide, flush with the window, top to status strip.
      assert.ok(Math.abs(m.inspector.width - 364) <= 1, `${label} is 364px wide, got ${m.inspector.width}`);
      assert.ok(Math.abs(m.inspector.right - m.start.right) <= 1, `${label} is flush with the right edge`);
      assert.ok(m.inspector.bottom <= m.start.bottom + 1, `${label} ends above the status strip`);
      assert.ok(m.scrollWidth <= m.clientWidth + 1, `${label} has no horizontal overflow (${m.scrollWidth} > ${m.clientWidth})`);

      // Preview on top, full width.
      assert.ok(m.preview, `${label} has the Last result preview`);
      assert.ok(Math.abs(m.preview.top - m.inspector.top) <= 1, `${label}: preview is at the top`);
      assert.ok(Math.abs(m.preview.width - m.inspector.width) <= 2, `${label}: preview spans the column`);
      assert.ok(m.preview.height >= 150, `${label}: preview is at least 150px tall, got ${m.preview.height}`);

      // Title row: name, star, more menu; path row with copy; chips.
      assert.ok(m.title.length > 0, `${label} has a title`);
      assert.match(m.pinLabel, /^(Pin|Unpin) /, `${label}: the star is named Pin/Unpin <name>`);
      assert.ok(m.moreActions && m.moreActions.width > 0, `${label} has the more-actions button`);
      assert.ok(m.copyPath && m.copyPath.width > 0, `${label} has the copy-path button`);
      assert.ok(m.path.length > 0, `${label} shows the path`);
      assert.ok(m.chips >= 2, `${label} shows chips, got ${m.chips}`);
      assert.ok(m.moreActions.right <= m.inspector.right && m.copyPath.right <= m.inspector.right, `${label}: title and path controls stay inside`);

      // Tabs: the sketch's names, one row, one selected, a labelled panel.
      assert.deepEqual(m.tabNames, expected.tabs, `${label} tabs`);
      assert.equal(m.tabTops.length, 1, `${label}: tabs share one row`);
      assert.equal(m.selectedTabs, 1, `${label}: exactly one tab is selected`);
      assert.ok(m.panel && m.panel.height > 40, `${label} shows a tab panel`);
      assert.match(m.panelLabelled, /-tab-/, `${label}: the panel is labelled by its tab`);

      // Sections of the overview are visible and in the sketch's order.
      for (const section of expected.sections) {
        assert.ok(m.sections.includes(section), `${label} shows the ${section} section, got ${m.sections.join(", ")}`);
      }
      assert.deepEqual(
        expected.sections.filter((s) => m.sections.includes(s)),
        m.sections.filter((s) => expected.sections.includes(s)),
        `${label}: sections are in order`,
      );

      // Action bar: pinned to the bottom, primary + split + external, no overlap, inside the column.
      assert.ok(Math.abs(m.foot.bottom - m.inspector.bottom) <= 1, `${label}: the action bar is at the bottom`);
      assert.ok(m.foot.bottom <= m.viewportHeight, `${label}: the action bar is visible without scrolling`);
      assert.equal(m.primaryText, expected.primary, `${label}: primary action`);
      assert.ok(m.parts[0] && m.parts[0].width >= 120, `${label}: the primary button is wide enough`);
      assert.ok(m.split || kind === "result", `${label}: has the open-options dropdown`);
      assert.ok(m.parts[2] && m.parts[2].width > 0, `${label}: has the open-externally button`);
      assert.ok(!m.footOverlap, `${label}: the action bar buttons do not overlap`);
      assert.ok(m.partsInside, `${label}: the action bar stays inside the column`);
      console.log(`${kind}: inspector layout ok (${m.sections.join(", ")})`);
    }

    // Runs tab of the sketch: Run | Started | Duration | Output, then the viewer buttons.
    await show(markup.projectRuns);
    const runs = await tab.evaluate(() => ({
      headers: [...document.querySelectorAll(".fm-start__inspector th[scope=col]")].map((n) => n.textContent.trim()),
      rows: document.querySelectorAll(".fm-start__inspector tbody tr").length,
      viewer: document.querySelector('[data-action="open-results-viewer"]')?.textContent?.trim() ?? "",
      download: document.querySelector('[aria-label="Download results"]')?.getBoundingClientRect().width ?? 0,
    }));
    assert.deepEqual(runs.headers, ["Run", "Started", "Duration", "Output"], "Runs table columns");
    assert.ok(runs.rows >= 2, "Runs table lists the runs and the linked folder");
    assert.equal(runs.viewer, "Open results viewer", "Runs tab has Open results viewer");
    assert.ok(runs.download > 0, "Runs tab has the download button");

    await show(markup.scriptRuns);
    const scriptRuns = await tab.evaluate(() => [...document.querySelectorAll(".fm-start__inspector th[scope=col]")].map((n) => n.textContent.trim()));
    assert.deepEqual(scriptRuns, ["Run", "Started", "Duration", "Output"], "Script Runs table columns");

    await show(markup.resultStages);
    const stages = await tab.evaluate(() => [...document.querySelectorAll(".fm-start__inspector th[scope=col]")].map((n) => n.textContent.trim()));
    assert.deepEqual(stages, ["Stage", "Steps", "Time"], "Result Stages table columns");

    await show(markup.projectReadOnly);
    const banner = await tab.evaluate(measureInspector);
    assert.equal(banner.banners.length, 1, "A read-only project shows one banner");
    assert.ok(banner.banners[0].width > 200 && banner.banners[0].right <= banner.inspector.right, "The banner fits the column");

    // WCAG AA of everything the inspectors draw, in both themes and on every tab fixture.
    let measured = 0;
    for (const theme of ["dark", "light"]) {
      for (const [name, html] of Object.entries(markup)) {
        await show(html);
        await tab.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        const results = await tab.evaluate(measureTextContrast);
        measured += results.length;
        for (const r of results) {
          if (r.ratio < 4.5) failures.push(`${theme}: inspector "${name}" ${r.selector} "${r.text}" = ${r.ratio.toFixed(2)}:1`);
        }
      }
    }
    console.log(`inspectors: ${measured} text elements checked for contrast in both themes`);
  } finally {
    await tab.close();
  }
}
