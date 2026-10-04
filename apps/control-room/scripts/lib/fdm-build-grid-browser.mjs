import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function qualifyFdmBuildGrid({
  consoleErrors,
  page,
  fixture,
  notFoundResponses,
  outputDir,
  workspaceUrl,
}) {
  const evidence = {
    command: null,
    explorer: null,
    operations: null,
    problems: null,
    status: "running",
    webgl: null,
  };

  try {
    await page.goto(workspaceUrl, {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });
    await page.locator(".fm-workspace-shell").waitFor({
      state: "visible",
      timeout: 30_000,
    });

    await page.getByRole("tab", { name: "Mesh", exact: true }).click();
    const buildGrid = page.locator('[data-action-id="grid.build-fdm"]');
    await buildGrid.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await buildGrid.isEnabled(),
      true,
      "Build Grid is disabled for an explicit FDM scene.",
    );
    assert.equal(
      await page.locator('[data-action-id="mesh.build-selected"]').count(),
      0,
      "FEM object-mesh build leaked into the FDM ribbon.",
    );
    assert.equal(
      await page.locator('[data-action-id="mesh.build-shared-domain"]').count(),
      0,
      "FEM shared-domain build leaked into the FDM ribbon.",
    );

    const meshNode = page.locator('[data-node-id="model:mesh"]');
    await meshNode.waitFor({ state: "visible", timeout: 30_000 });
    await meshNode.click({ button: "right" });
    const explorerBuildGrid = page.getByRole("menuitem", {
      name: "Build Grid",
      exact: true,
    });
    await explorerBuildGrid.waitFor({ state: "visible", timeout: 10_000 });
    const explorerDisabledReason = await explorerBuildGrid.getAttribute("title");
    assert.equal(
      await explorerBuildGrid.isEnabled(),
      true,
      `Explorer exposed Build Grid as unavailable for the current FDM scene: ${explorerDisabledReason ?? "no reason published"}.`,
    );
    await page.keyboard.press("Escape");

    await buildGrid.click();
    await waitUntil(
      () => fixture.gridCommandBodies.length === 1,
      "Build Grid did not submit an FDM grid refresh.",
    );
    const command = fixture.gridCommandBodies[0];
    assert.equal(command.kind, "fdm_grid_refresh");
    assert.equal(command.reason, "explicit_build_grid");
    assert.equal(command.precondition?.scene_revision, fixture.revision);
    assert.match(command.client_intent_id ?? "", /^fdm-grid-refresh-/);

    const operationsTab = page.getByRole("tab", {
      name: "Operations",
      exact: true,
    });
    await operationsTab.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await operationsTab.getAttribute("aria-selected"),
      "true",
      "Build Grid did not focus the shared Operations projection.",
    );
    const commandOperation = page.locator(
      '[data-operation-id="command:fixture-fdm-grid-command"]',
    );
    await commandOperation.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await commandOperation.innerText(), /fdm_grid_refresh/i);
    assert.match(await commandOperation.innerText(), /completed/i);

    const problemsTab = page.getByRole("tab", {
      name: "Problems",
      exact: true,
    });
    await problemsTab.click();
    const geometryProblem = page.locator(
      '[data-problem-id="geometry:fixture-grid-extent-problem"]',
    );
    await geometryProblem.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await geometryProblem.innerText(),
      /GRID_EXTENT_REVIEW_REQUIRED/,
    );
    assert.match(await geometryProblem.innerText(), /scene revision|12/i);

    const canvas = page.locator(".fm-viewport-3d canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 30_000 });
    evidence.webgl = await canvas.evaluate((element) => {
      const gl = element.getContext("webgl2") ?? element.getContext("webgl");
      return gl
        ? {
            height: gl.drawingBufferHeight,
            lost: gl.isContextLost(),
            width: gl.drawingBufferWidth,
          }
        : null;
    });
    assert.ok(
      evidence.webgl &&
        !evidence.webgl.lost &&
        evidence.webgl.width > 0 &&
        evidence.webgl.height > 0,
      "FDM Build Grid smoke ended with an unhealthy 3D drawing buffer.",
    );
    assert.deepEqual(
      notFoundResponses,
      [],
      `FDM Build Grid smoke observed 404 responses: ${notFoundResponses.join("\n")}`,
    );
    assert.deepEqual(
      consoleErrors,
      [],
      `FDM Build Grid smoke observed browser errors: ${consoleErrors.join("\n")}`,
    );

    evidence.command = command;
    evidence.explorer = { command: "grid.build-fdm", enabled: true };
    evidence.operations = {
      command: "fixture-fdm-grid-command",
      focusedAfterSubmit: true,
      status: "completed",
    };
    evidence.problems = {
      code: "GRID_EXTENT_REVIEW_REQUIRED",
      revision: fixture.revision,
      severity: "error",
    };
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.stack ?? String(error);
    await page.screenshot({
      fullPage: true,
      path: resolve(outputDir, "fdm-build-grid-failure.png"),
    });
    throw error;
  } finally {
    await writeFile(
      resolve(outputDir, "fdm-build-grid-browser.json"),
      JSON.stringify(evidence, null, 2),
    );
  }

  console.log(JSON.stringify(evidence, null, 2));
}

async function waitUntil(condition, message) {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.ok(condition(), message);
}
