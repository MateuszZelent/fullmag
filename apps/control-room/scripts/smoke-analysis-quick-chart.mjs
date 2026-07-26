const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeout = 120_000;

const playwright = await loadPlaywright();
if (!playwright?.chromium) throw new Error("Playwright is required.");
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const tableRequests = [];
const tableResponses = [];
const pageErrors = [];
page.on("request", (request) => {
  if (request.url().includes("/data/tables/default/")) tableRequests.push(request.url());
});
page.on("response", (response) => {
  if (response.url().includes("/data/tables/default/")) {
    tableResponses.push({
      contentType: response.headers()["content-type"] ?? null,
      status: response.status(),
      url: response.url(),
    });
  }
});
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript(() => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    controlRoomApiBase: "http://localhost:8081",
  };
});
await page.route(
  "**/v2/sessions/current/data/tables/default/rows.bin?**",
  async (route) => {
    const url = new URL(route.request().url());
    const columns = (url.searchParams.get("columns") ?? "").split(",").filter(Boolean);
    await route.fulfill({
      body: makeRowsFixture(columns, 256),
      contentType: "application/vnd.fullmag.table-rows.v1+octet-stream",
      headers: { "access-control-allow-origin": "*" },
      status: 200,
    });
  },
);

try {
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout });
  await viewportTab(page, "Analysis").click();
  await page.locator(".fm-analysis-plots__legend-item").first().waitFor({ timeout });
  await page.waitForFunction(
    () => document.querySelectorAll(".fm-analysis-plots__column-row").length >= 2,
    { timeout },
  );
  await page.locator(".fm-analysis-plots__legend-item").first().click();
  await page.waitForTimeout(500);
  await viewportTab(page, "3D Viewport").click();
  await page.keyboard.press("Control+Shift+p");
  await page.getByPlaceholder("Search commands").fill("Open Quick Chart");
  await page.getByText("Open Quick Chart", { exact: true }).last().click();
  const dock = page.locator(".fm-analysis-quick-chart-dock");
  await page.waitForTimeout(500);
  if (!(await dock.isVisible())) {
    await page.locator(".fm-footer__tab").filter({ hasText: "Quick Chart" }).click();
  }
  await dock.waitFor({ state: "visible", timeout });
  await dock.getByRole("button", { name: "Pin Quick Chart" }).click();
  await dock.getByRole("button", { name: "Unpin Quick Chart" }).click();
  const keyboardSurface = dock.locator(".fm-quick-chart__keyboard-surface");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".fm-quick-chart__keyboard-surface")
        ?.getAttribute("aria-label")
        ?.includes("row "),
    { timeout: 10_000 },
  ).catch(async () => {
    throw new Error(
      `Quick Chart samples did not become ready: key=${await dock.locator("[data-chart-model-key]").getAttribute("data-chart-model-key")} requests=${JSON.stringify(tableRequests.slice(-10))} responses=${JSON.stringify(tableResponses.slice(-10))} errors=${JSON.stringify(pageErrors.slice(-10))} ${(await dock.innerText()).slice(0, 1_500)}`,
    );
  });
  await keyboardSurface.focus();
  await keyboardSurface.press("ArrowRight");
  const proof = await page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    const quickChart = document.querySelector(".fm-quick-chart__canvas canvas");
    const gl = canvas instanceof HTMLCanvasElement
      ? canvas.getContext("webgl2") ?? canvas.getContext("webgl")
      : null;
    return {
      activeModuleId: document
        .querySelector("[data-slot-id='viewport-main']")
        ?.getAttribute("data-active-module-id") ?? null,
      contextLost: gl?.isContextLost() ?? true,
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      keyboardCursor: document.activeElement?.getAttribute("aria-label") ?? null,
      quickChartHeight: quickChart instanceof HTMLCanvasElement ? quickChart.height : 0,
      quickChartWidth: quickChart instanceof HTMLCanvasElement ? quickChart.width : 0,
      unpinned: Array.from(
        document.querySelectorAll(".fm-analysis-quick-chart-dock button"),
      ).some(
        (button) =>
          button.textContent?.trim() === "Pin Quick Chart" &&
          button.getAttribute("aria-pressed") === "false",
      ),
    };
  });
  if (
    proof.activeModuleId !== "viewport-3d" ||
    proof.contextLost ||
    proof.drawingBufferHeight <= 0 ||
    proof.drawingBufferWidth <= 0 ||
    proof.quickChartHeight <= 0 ||
    proof.quickChartWidth <= 0 ||
    !proof.keyboardCursor?.includes("row") ||
    !proof.unpinned
  ) {
    throw new Error(`Quick Chart smoke failed: ${JSON.stringify(proof)}`);
  }
  console.log(`Analysis Quick Chart smoke passed: ${JSON.stringify(proof)}`);
} finally {
  await browser.close();
}

function viewportTab(page, text) {
  return page.locator(".fm-viewport-tabs__trigger").filter({ hasText: text }).first();
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return await import("@playwright/test");
  }
}

function makeRowsFixture(columns, rowCount) {
  const buffer = Buffer.alloc(60 + rowCount * columns.length * 8);
  buffer.write("FMTB", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeBigUInt64LE(1n, 8);
  buffer.writeBigUInt64LE(1n, 16);
  buffer.writeBigUInt64LE(0n, 24);
  buffer.writeBigUInt64LE(BigInt(rowCount), 32);
  buffer.writeBigUInt64LE(BigInt(rowCount), 40);
  buffer.writeBigUInt64LE(BigInt(rowCount), 48);
  buffer.writeUInt32LE(columns.length, 56);
  let offset = 60;
  for (let row = 0; row < rowCount; row += 1) {
    for (const column of columns) {
      const value = column === "step"
        ? row
        : column === "t" || column === "pseudo_time_s"
          ? row * 1e-12
          : column === "e_total"
            ? -1e-18 * (1 + row / rowCount)
            : Math.sin(row / 20);
      buffer.writeDoubleLE(value, offset);
      offset += 8;
    }
  }
  return buffer;
}
